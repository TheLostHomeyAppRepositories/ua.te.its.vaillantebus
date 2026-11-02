'use strict';

// Direct connection to an eBUS adapter speaking ebusd's "enhanced protocol" over
// TCP: ebusd.eu v5 / v5-C6 (port 9999) or an ESP firmware that implements it.
// The adapter does bus arbitration itself; this side then sends the rest of the
// telegram symbol by symbol and checks each echo, so Wi-Fi latency only slows a
// transaction down instead of breaking arbitration.
//
// Wire format: a byte < 0x80 is a RECEIVED symbol. Otherwise two bytes
// 11cccc dd / 10 dddddd carry command c with 8-bit data d.

const net = require('net');
const { EventEmitter } = require('events');
const { SYN, ACK, NAK, crc, escape, isMaster } = require('./ebus');

const CMD = {
  INIT: 0x0, SEND: 0x1, START: 0x2, INFO: 0x3,
};
const RSP = {
  RESETTED: 0x0, RECEIVED: 0x1, STARTED: 0x2, INFO: 0x3, FAILED: 0xA, ERROR_EBUS: 0xB, ERROR_HOST: 0xC,
};

const EARLY_ECHO_NS = 4000000n; // 4 ms, just under one eBUS symbol

const enc = (cmd, d) => Buffer.from([0xC0 | (cmd << 2) | (d >> 6), 0x80 | (d & 0x3F)]);

class EnhancedTransport extends EventEmitter {
  constructor({
    host, port = 9999, address = 0x31, timeout = 1500, log = () => {},
  }) {
    super();
    if (!isMaster(address)) throw new Error(`0x${address.toString(16)} is not a master address`);
    this.host = host;
    this.port = port;
    this.address = address;
    this.timeout = timeout;
    this.log = log;
    this.sock = null;
    this.hi = null; // first byte of a 2-byte sequence
    this.waiter = null;
    this.inbox = [];
    this.active = false; // inside a transaction
    this.queue = Promise.resolve();
    this.lastSyn = 0;
    this.tStarted = 0; // when the adapter reported won arbitration
    this.stats = { ok: 0, retried: 0, failed: 0, early: 0, lateMs: [] };
  }

  get connected() { return !!this.sock && !this.sock.destroyed; }

  async connect() {
    if (this.connected) return;
    await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const fail = (err) => { s.destroy(); reject(err); };
      s.setTimeout(8000, () => fail(new Error('connect timeout')));
      s.once('error', fail);
      s.once('connect', () => {
        s.setTimeout(0);
        s.setNoDelay(true);
        s.removeListener('error', fail);
        s.setKeepAlive(true, 30000);
        s.on('data', (d) => this._onData(d));
        s.on('error', (err) => this.log('adapter socket error', err.message));
        s.on('close', () => {
          this.sock = null;
          this._push({ cmd: -1 });
          this.emit('disconnected');
        });
        this.sock = s;
        s.write(enc(CMD.INIT, 0x01));
        this.emit('connected');
        resolve();
      });
    });
  }

  close() {
    if (this.sock) this.sock.destroy();
    this.sock = null;
  }

  _onData(d) {
    for (const b of d) {
      if (this.hi !== null) {
        const first = this.hi;
        this.hi = null;
        if ((b & 0xC0) !== 0x80) { this.log('enhanced: framing error'); continue; }
        this._event((first >> 2) & 0x0F, ((first & 0x03) << 6) | (b & 0x3F));
      } else if (b < 0x80) {
        this._event(RSP.RECEIVED, b);
      } else if ((b & 0xC0) === 0xC0) {
        this.hi = b;
      } else {
        this.log('enhanced: stray byte', b);
      }
    }
  }

  _event(cmd, data) {
    if (cmd === RSP.RECEIVED && data === SYN) this.lastSyn = Date.now();
    if (cmd === RSP.ERROR_EBUS || cmd === RSP.ERROR_HOST) this.log(`enhanced: adapter error ${cmd} 0x${data.toString(16)}`);
    if (cmd === RSP.RESETTED) this.log(`enhanced: adapter reset, features 0x${data.toString(16)}`);
    if (!this.active) return; // idle bus traffic
    this._push({ cmd, data });
  }

  _push(ev) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(ev); } else this.inbox.push(ev);
  }

  _next(ms = this.timeout) {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiter = null; reject(new Error('adapter timeout')); }, ms);
      this.waiter = (ev) => { clearTimeout(t); if (ev.cmd === -1) reject(new Error('connection closed')); else resolve(ev); };
    });
  }

  /** Next symbol seen on the bus. */
  async _recv(ms) {
    for (;;) {
      const ev = await this._next(ms);
      if (ev.cmd === RSP.RECEIVED) return ev.data;
      if (ev.cmd === RSP.ERROR_EBUS || ev.cmd === RSP.ERROR_HOST) throw new Error(`adapter error ${ev.cmd}`);
    }
  }

  async _send(sym) {
    const t0 = process.hrtime.bigint();
    this.sock.write(enc(CMD.SEND, sym));
    let echo = await this._recv();
    // One symbol takes ~4.2 ms on the wire at 2400 Bd, so a SYN that shows up sooner
    // was already queued in the adapter and is not the echo of ours: wait for the real one.
    for (let skipped = 0; echo === SYN && sym !== SYN && skipped < 2
      && process.hrtime.bigint() - t0 < EARLY_ECHO_NS; skipped++) {
      this.stats.early++;
      echo = await this._recv();
    }
    if (echo !== sym) {
      const late = Date.now() - this.tStarted;
      this.stats.lateMs.push(late);
      if (this.stats.lateMs.length > 50) this.stats.lateMs.shift();
      throw new Error(`collision: sent ${sym.toString(16)} got ${echo.toString(16)} (${late} ms after STARTED)`);
    }
  }

  async _arbitrate() {
    for (let attempt = 0; attempt < 5; attempt++) {
      this.sock.write(enc(CMD.START, this.address));
      for (;;) {
        const ev = await this._next(3000);
        if (ev.cmd === RSP.STARTED) {
          if (ev.data === this.address) { this.tStarted = Date.now(); return; }
          throw new Error('started with foreign address');
        }
        if (ev.cmd === RSP.FAILED) break; // lost to another master, try at next SYN
        if (ev.cmd === RSP.ERROR_EBUS || ev.cmd === RSP.ERROR_HOST) throw new Error(`adapter error ${ev.cmd}`);
      }
    }
    throw new Error('arbitration lost 5 times');
  }

  async _release() {
    try { this.sock.write(enc(CMD.SEND, SYN)); await this._recv(500); } catch (_) { /* best effort */ }
  }

  async _transact(zz, pbsb, data) {
    const d = Array.from(data || []);
    const tele = [this.address, zz, pbsb >> 8, pbsb & 0xFF, d.length, ...d];
    const wire = [...escape(tele.slice(1)), ...escape([crc(tele)])];
    this.inbox = [];
    this.active = true;
    try {
      await this._arbitrate();
      for (const s of wire) await this._send(s);
      if (zz === 0xFE) { await this._release(); return []; }

      const ack = await this._recv();
      if (ack === NAK) throw new Error('slave NAK');
      if (ack !== ACK) throw new Error(`no ACK (got ${ack.toString(16)})`);
      if (isMaster(zz)) { await this._release(); return []; }

      // slave answer: NN DD.. CRC, escaped on the wire
      const readSym = async () => {
        const b = await this._recv();
        if (b !== 0xA9) return b;
        const e = await this._recv();
        return e === 0x01 ? SYN : 0xA9;
      };
      const nn = await readSym();
      const ans = [];
      for (let i = 0; i < nn; i++) ans.push(await readSym());
      const c = await readSym();
      if (c !== crc([nn, ...ans])) {
        await this._send(NAK);
        throw new Error('answer CRC error');
      }
      await this._send(ACK);
      await this._release();
      return ans;
    } catch (err) {
      if (this.connected) await this._release();
      throw err;
    } finally {
      this.active = false;
      this.inbox = [];
    }
  }

  /**
   * Master-slave exchange, returns the slave's data bytes (without NN). Serialized.
   * A slow host (Homey on Wi-Fi) sometimes answers STARTED too late and the boiler's
   * SYN generator closes the bus, so a few quick retries are normal; only the final
   * failure is logged, plus a summary every 200 requests.
   */
  request(zz, pbsb, data, attempts = 4) {
    const run = async () => {
      let last;
      for (let i = 0; i < attempts; i++) {
        try {
          await this.connect();
          const ans = await this._transact(zz, pbsb, data);
          if (i) this.stats.retried++; else this.stats.ok++;
          this._summary();
          return ans;
        } catch (err) {
          last = err;
          if (/connection closed|connect timeout|ECONN|EHOST/.test(err.message)) await new Promise((r) => setTimeout(r, 500));
        }
      }
      this.stats.failed++;
      this.log(`enhanced: gave up after ${attempts} attempts:`, last.message);
      this._summary();
      throw last;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  _summary() {
    const {
      ok, retried, failed, early, lateMs,
    } = this.stats;
    if (ok + retried + failed < 200) return;
    const sorted = [...lateMs].sort((a, b) => a - b);
    const med = sorted.length ? sorted[sorted.length >> 1] : '-';
    this.log(`enhanced: last 200 requests: ${ok} first try, ${retried} after retry, ${failed} failed, ${early} early SYN skipped; collision delay after STARTED median ${med} ms, max ${sorted[sorted.length - 1] ?? '-'} ms`);
    this.stats = { ok: 0, retried: 0, failed: 0, early: 0, lateMs: [] };
  }

  /** True if bus SYN symbols arrived recently (adapter wired to a live bus). */
  get signal() { return Date.now() - this.lastSyn < 5000; }
}

module.exports = EnhancedTransport;
