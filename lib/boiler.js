'use strict';

// High-level access to the BAI: one poll round of all values, and SetMode.

const { BAI, READS, SENSOR, decodeRead, setModeData, SETMODE_PBSB } = require('./bai');
const EbusdTransport = require('./transport-ebusd');
const EnhancedTransport = require('./transport-enhanced');

function makeTransport({ transport, host, port, address, log }) {
  if (transport === 'enhanced') return new EnhancedTransport({ host, port: port || 9999, address, log });
  return new EbusdTransport({ host, port: port || 8888, log });
}

const sensorOk = (r) => r.sensor == null || r.sensor === 0;

class Boiler {
  constructor(opts) {
    this.t = makeTransport(opts);
    this.log = opts.log || (() => {});
    this.stateEmpty = 0; // empty answers to stateNumber in a row
  }

  close() { this.t.close(); }

  async read(name) {
    const m = READS[name];
    const data = await this.t.request(BAI, m.pbsb, m.data);
    return decodeRead(name, data);
  }

  /** Identification (07 04): manufacturer, device id, sw, hw. */
  async identify() {
    const d = await this.t.request(BAI, 0x0704, []);
    if (d.length < 10) throw new Error('no identification answer');
    return {
      manufacturer: d[0] === 0xB5 ? 'Vaillant' : `0x${d[0].toString(16)}`,
      id: Buffer.from(d.slice(1, 6)).toString('latin1').replace(/\0/g, '').trim(),
      sw: `${d[6].toString(16).padStart(2, '0')}${d[7].toString(16).padStart(2, '0')}`,
      hw: `${d[8].toString(16).padStart(2, '0')}${d[9].toString(16).padStart(2, '0')}`,
    };
  }

  /** Read everything the device shows. Single failures leave the value undefined. */
  async poll() {
    const s = {};
    const tryRead = async (name, fn) => {
      try { fn(await this.read(name)); } catch (err) { this.log(`read ${name}: ${err.message}`); }
    };
    await tryRead('flowTemp', (r) => { s.flowTemp = sensorOk(r) ? r.value : null; });
    await tryRead('returnTemp', (r) => { s.returnTemp = sensorOk(r) ? r.value : null; });
    await tryRead('hwcTemp', (r) => { s.hwcTemp = sensorOk(r) ? r.value : null; });
    await tryRead('flowTempDesired', (r) => { s.flowTempDesired = r.value; });
    await tryRead('storageTempDesired', (r) => { s.hwcTempDesired = r.value; });
    await tryRead('waterPressure', (r) => { s.pressure = sensorOk(r) ? r.value : null; s.pressureSensor = SENSOR[r.sensor] || r.sensor; });
    await tryRead('flame', (r) => { s.flame = r.value === 0x0F; });
    await tryRead('modulation', (r) => { s.modulation = r.value; });
    await tryRead('hwcDemand', (r) => { s.hwcDemand = r.value === 1; });
    await tryRead('roomThermostat', (r) => { s.roomThermostat = r.value === 1; });
    await tryRead('status01', (r) => { s.pump = r.pump; });
    // Some BAI firmware answer register 0x00AB with no data at all (GitHub #1): after
    // three empty answers in a row stop asking, instead of logging it every poll.
    if (this.stateEmpty < 3) {
      try {
        s.state = (await this.read('stateNumber')).value;
        this.stateEmpty = 0;
      } catch (err) {
        if (/got 0$/.test(err.message)) {
          this.stateEmpty++;
          if (this.stateEmpty >= 3) this.log('stateNumber: the boiler does not report it (empty answer), not polling it any more');
        } else {
          this.log(`read stateNumber: ${err.message}`);
        }
      }
    }
    await tryRead('currentError', (r) => {
      s.errors = [r.e0, r.e1, r.e2, r.e3, r.e4].filter((e) => e != null && e !== 0);
    });
    return s;
  }

  /** Send B510 SetMode once; the boiler answers 01 on success. */
  async setMode(opts) {
    const ans = await this.t.request(BAI, SETMODE_PBSB, setModeData(opts));
    if (ans.length && ans[0] !== 0x01) this.log(`SetMode answer ${Buffer.from(ans).toString('hex')}`);
    return ans;
  }
}

module.exports = { Boiler, makeTransport };
