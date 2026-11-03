'use strict';

const Homey = require('homey');
const { Boiler } = require('../../lib/boiler');
const heating = require('../../lib/heating');
const { describe } = require('../../lib/fcodes');
const { Inputs } = require('../../lib/inputs');

// While "Controlled by Homey" is on, this device acts as the boiler's room
// controller: every control interval it computes a flow setpoint (manual,
// or heating curve + room correction) and sends SetMode, like a VRC does.
// While it is off, Homey only reads, and the flow setpoint shows what the
// boiler currently uses.

const MODES = ['comfort', 'eco', 'away', 'boost', 'off'];

class BoilerDevice extends Homey.Device {
  async onInit() {
    this.boiler = null;
    this.pollTimer = null;
    this.controlTimer = null;
    this.failures = 0;
    this.lastPoll = 0;

    await this._migrate();

    const listen = (cap, fn) => this.registerCapabilityListener(cap, (v) => {
      this.log(`${cap} -> ${v} (from Homey)`);
      return fn(v);
    });
    listen('target_temperature', (v) => this.setRoomTarget(v));
    listen('target_temperature.flow', (v) => this.setManualFlow(v));
    listen('target_temperature.hwc', (v) => this.setHwcTarget(v));
    listen('heating_mode', (v) => this.setMode(v));
    listen('bus_control', (v) => this.setBusControl(v));

    this.ctl = this.getStoreValue('ctl') || {};
    this.inputs = new Inputs(this.getStoreValue('inputs') || {});
    this._t = {
      room: this.getStoreValue('room') ?? 21,
      flow: this.getStoreValue('flow') ?? 40,
      hwc: this.getStoreValue('hwc') ?? 50,
      mode: this.getStoreValue('mode') ?? 'comfort',
      control: this.getStoreValue('control') ?? false,
      gas: this.getStoreValue('gas') ?? 0,
    };
    await this._show();
    this._connect();
  }

  /** Bring a device paired with an older version to the current capability list. */
  async _migrate() {
    if (this.getClass() !== this.driver.manifest.class) await this.setClass(this.driver.manifest.class).catch(this.error);
    const want = this.driver.manifest.capabilities;
    for (const c of this.getCapabilities()) {
      if (!want.includes(c)) await this.removeCapability(c).catch(this.error);
    }
    for (const c of want) {
      if (!this.hasCapability(c)) await this.addCapability(c).catch(this.error);
    }
  }

  get app() { return this.homey.app; }

  _connect() {
    if (this.boiler) this.boiler.close();
    const s = this.getSettings();
    this.boiler = new Boiler({
      transport: s.transport,
      host: s.host,
      port: s.port,
      address: parseInt(s.address || '31', 16),
      log: (...a) => this.log(...a),
    });
    this._schedule();
  }

  _schedule() {
    this.homey.clearInterval(this.pollTimer);
    this.homey.clearInterval(this.controlTimer);
    const s = this.getSettings();
    this.pollTimer = this.homey.setInterval(() => this.poll(), s.poll_interval * 1000);
    this.controlTimer = this.homey.setInterval(() => this.control(), s.control_interval * 1000);
    this.poll();
  }

  async _set(cap, v) {
    if (v === undefined || !this.hasCapability(cap)) return;
    if (this.getCapabilityValue(cap) !== v) await this.setCapabilityValue(cap, v).catch(this.error);
  }

  async _save() {
    for (const [k, v] of Object.entries(this._t)) await this.setStoreValue(k, v);
    await this.setStoreValue('ctl', this.ctl);
  }

  async _show() {
    await this._set('target_temperature', this._t.room);
    await this._set('target_temperature.flow', this._t.flow);
    await this._set('target_temperature.hwc', this._t.hwc);
    await this._set('heating_mode', this._t.mode);
    await this._set('bus_control', this._t.control);
    await this._set('meter_gas', Math.round(this._t.gas * 1000) / 1000);
  }

  // ---------- reading ----------

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const st = await this.boiler.poll();
      if (st.flowTemp === undefined && st.pressure === undefined) throw new Error('no answers from boiler');
      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable();
      await this._apply(st);
    } catch (err) {
      this.failures++;
      this.log('poll failed:', err.message);
      if (this.failures >= 3) await this.setUnavailable(err.message).catch(this.error);
    } finally {
      this.polling = false;
    }
    await this._readSensors();
  }

  /** Room and outdoor temperature: what the user's Flows reported, else the weather. */
  async _readSensors() {
    const s = this.getSettings();
    const maxAge = (s.sensor_timeout ?? 180) * 60e3;
    try {
      this.room = this.inputs.room(maxAge);
      let outdoor = this.inputs.outdoor(maxAge);
      if (outdoor == null && s.use_weather !== false) outdoor = await this.app.weather.temperature();
      this.outdoor = outdoor;
      await this._set('measure_temperature', this.room);
      await this._set('measure_temperature.outdoor', this.outdoor);
    } catch (err) {
      this.log('sensors:', err.message);
    }
  }

  // ---------- values reported by the user's Flows ----------

  async _saveInputs() {
    await this.setStoreValue('inputs', this.inputs.toJSON());
  }

  async reportRoom(temperature, name) {
    this.inputs.reportRoom(temperature, name);
    await this._saveInputs();
    await this._readSensors();
  }

  async reportOutdoor(temperature) {
    this.inputs.reportOutdoor(temperature);
    await this._saveInputs();
    await this._readSensors();
  }

  /** A zone valve switched: react within seconds rather than at the next control interval. */
  async setValve(number, open) {
    this.inputs.setValve(number, open);
    await this._saveInputs();
    this.homey.clearTimeout(this.valveTimer);
    this.valveTimer = this.homey.setTimeout(() => this.control(), 2000);
  }

  async _apply(st) {
    const s = this.getSettings();
    const prev = {
      flame: this.getCapabilityValue('flame_on'),
      pressure: this.getCapabilityValue('measure_water_pressure'),
      error: this.getCapabilityValue('boiler_error'),
      lowP: this.getCapabilityValue('alarm_water_pressure'),
    };

    await this._set('measure_temperature.flow', st.flowTemp);
    await this._set('measure_temperature.return', st.returnTemp);
    await this._set('measure_temperature.hwc', st.hwcTemp);
    await this._set('measure_water_pressure', st.pressure);
    await this._set('measure_modulation', st.modulation);
    await this._set('flame_on', st.flame);
    await this._set('hwc_demand', st.hwcDemand);
    // Without bus control the app makes no heat request of its own, so show what the
    // boiler does: burner on and not for hot water = heating (its own panel/curve).
    if (!this._t.control && st.flame !== undefined && st.hwcDemand !== undefined) {
      await this._set('heating_active', st.flame && !st.hwcDemand);
    }
    if (st.state !== undefined && st.state !== this._lastState) {
      this.log(`boiler state ${this._lastState ?? '-'} -> ${st.state} (flame ${st.flame}, hwc ${st.hwcDemand})`);
      this._lastState = st.state;
    }

    // gas estimate, integrated between polls (a gap longer than 5 min is not counted)
    const now = Date.now();
    const dt = this.lastPoll ? now - this.lastPoll : 0;
    this.lastPoll = now;
    if (st.flame !== undefined) {
      const g = heating.gasUsed(
        { flame: st.flame, modulation: st.modulation, dtMs: dt <= 300e3 ? dt : 0 },
        { maxKw: s.max_kw, minKw: s.min_kw, kwhPerM3: s.kwh_per_m3, efficiency: s.efficiency / 100 },
      );
      await this._set('measure_heat_power', Math.round(g.kw * 10) / 10);
      if (g.m3 > 0) {
        this._t.gas += g.m3;
        await this._set('meter_gas', Math.round(this._t.gas * 1000) / 1000);
        await this.setStoreValue('gas', this._t.gas);
      }
    }

    // faults
    if (st.errors !== undefined) {
      const text = st.errors.length ? st.errors.map(describe).join(', ') : 'OK';
      await this._set('boiler_error', text);
      await this._set('alarm_generic', st.errors.length > 0);
      if (prev.error != null && prev.error !== text) {
        this.driver.errorChanged.trigger(this, { error: text, active: st.errors.length > 0 }).catch(this.error);
      }
    }
    if (st.flame !== undefined && prev.flame != null && prev.flame !== st.flame) {
      (st.flame ? this.driver.flameOn : this.driver.flameOff).trigger(this).catch(this.error);
    }

    // pressure: change trigger plus a low-pressure alarm with 0.1 bar hysteresis
    if (st.pressure != null) {
      if (prev.pressure != null && Math.abs(prev.pressure - st.pressure) >= 0.05) {
        this.driver.pressureChanged.trigger(this, { pressure: st.pressure }).catch(this.error);
      }
      const low = prev.lowP ? st.pressure < s.pressure_min + 0.1 : st.pressure < s.pressure_min;
      if (low !== !!prev.lowP) {
        await this._set('alarm_water_pressure', low);
        (low ? this.driver.pressureLow : this.driver.pressureOk).trigger(this, { pressure: st.pressure }).catch(this.error);
      }
    }

    if (!this._t.control && st.flowTempDesired >= 20) {
      this._t.flow = st.flowTempDesired;
      await this._set('target_temperature.flow', st.flowTempDesired);
    }
    if (!this._t.control && st.hwcTempDesired >= 30) {
      this._t.hwc = st.hwcTempDesired;
      await this._set('target_temperature.hwc', st.hwcTempDesired);
    }
  }

  // ---------- control ----------

  async control() {
    if (!this._t.control) return;
    const s = this.getSettings();

    if (this._t.mode === 'boost' && this.ctl.boostUntil && Date.now() > this.ctl.boostUntil) {
      await this.setMode(this.ctl.beforeBoost || 'comfort');
      return;
    }

    const r = heating.step({
      mode: this._t.mode,
      regulation: s.regulation,
      manualFlow: this._t.flow,
      room: this.room ?? null,
      outdoor: this.outdoor ?? null,
    }, {
      comfort: this._t.room,
      ecoDelta: s.eco_delta,
      away: s.away_temp,
      slope: s.curve_slope,
      shift: s.curve_shift,
      minFlow: s.min_flow,
      maxFlow: s.max_flow,
      heatingLimit: s.heating_limit,
      roomGain: s.room_gain,
      roomIntegral: s.room_integral,
      roomHyst: s.room_hyst,
      boostFlow: s.boost_flow,
    }, this.ctl.pid);
    this.ctl.pid = r.state;

    // zone valves: heat only while at least one is open, after the actuator delay
    if (r.heating) {
      const v = this.inputs.valveState(s.valve_count ?? 0);
      if (v.selected) {
        if (!v.open) {
          this.ctl.valvesSince = null;
          if (s.no_demand === 'off') {
            r.heating = false;
            r.reason += ', no zone valve open';
          } else {
            r.flow = Math.min(r.flow, s.standby_flow);
            r.reason += `, no zone valve open: keep warm ${s.standby_flow}`;
          }
        } else {
          this.ctl.valvesSince = this.ctl.valvesSince || Date.now();
          const wait = s.valve_delay * 60e3 - (Date.now() - this.ctl.valvesSince);
          if (wait > 0) {
            r.heating = false;
            r.reason += `, ${v.open} valve(s) opening`;
            this.homey.clearTimeout(this.valveTimer);
            this.valveTimer = this.homey.setTimeout(() => this.control(), wait + 1000);
          } else {
            r.reason += `, ${v.open}/${v.selected} valves open`;
          }
        }
      }
    }
    await this.setStoreValue('ctl', this.ctl);

    if (s.regulation !== 'manual' || this._t.mode === 'boost') await this._set('target_temperature.flow', r.flow);
    await this._set('heating_active', r.heating);
    if (r.reason !== this.lastReason) { this.log('control:', r.reason, '->', r.flow, r.heating ? 'heat' : 'no heat'); this.lastReason = r.reason; }

    try {
      await this.boiler.setMode({ flowTemp: r.flow, hwcTemp: this._t.hwc, disableHc: !r.heating });
    } catch (err) {
      this.log('SetMode failed:', err.message);
    }
  }

  async _takeControl() {
    this._t.control = true;
    await this._save();
    await this._show();
    await this.control();
  }

  async setRoomTarget(v) {
    this._t.room = v;
    if (this._t.mode !== 'comfort' && this._t.mode !== 'boost') this._t.mode = 'comfort';
    await this._takeControl();
  }

  async setManualFlow(v) {
    this._t.flow = v;
    if (this.getSetting('regulation') !== 'manual') await this.setSettings({ regulation: 'manual' });
    await this._takeControl();
  }

  async setHwcTarget(v) {
    this._t.hwc = v;
    await this._takeControl();
  }

  async setMode(mode, minutes) {
    if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
    const prev = this._t.mode;
    if (mode === 'boost') {
      if (prev !== 'boost') this.ctl.beforeBoost = prev;
      this.ctl.boostUntil = Date.now() + (minutes || this.getSetting('boost_minutes')) * 60e3;
    }
    this._t.mode = mode;
    if (prev !== mode) this.driver.modeChanged.trigger(this, { mode }).catch(this.error);
    await this._takeControl();
  }

  async setRegulation(regulation) {
    await this.setSettings({ regulation });
    this.ctl.pid = {};
    await this._takeControl();
  }

  async setBusControl(on) {
    this._t.control = on;
    await this._save();
    await this._show();
    // off: just stop re-sending; the boiler keeps the last value until its panel is used
    if (on) await this.control();
    this.homey.setTimeout(() => this.poll(), 3000);
  }

  async resetGas(value = 0) {
    this._t.gas = value;
    await this._save();
    await this._show();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some((k) => ['transport', 'host', 'port', 'address'].includes(k))) {
      this.homey.setTimeout(() => this._connect(), 500);
    } else if (changedKeys.some((k) => k.endsWith('_interval'))) {
      this.homey.setTimeout(() => this._schedule(), 500);
    }
    if (changedKeys.includes('regulation') && newSettings.regulation !== 'manual') this.ctl.pid = {};
  }

  async onDeleted() {
    this.onUninit();
  }

  async onUninit() {
    this.homey.clearInterval(this.pollTimer);
    this.homey.clearInterval(this.controlTimer);
    this.homey.clearTimeout(this.valveTimer);
    if (this.boiler) this.boiler.close();
  }
}

module.exports = BoilerDevice;
