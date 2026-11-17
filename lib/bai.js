'use strict';

// Vaillant BAI (ecoTEC/turboTEC burner control, slave 0x08) messages, taken from
// ebusd-configuration vaillant/08.bai.csv as loaded for BAI00 SW0403 HW0903.

const { types, decode } = require('./ebus');

const BAI = 0x08;

// b509 0d LL HH = read register; answer is the value (plus sensor state where noted)
const reg = (id, fields) => ({ pbsb: 0xB509, data: [0x0D, id & 0xFF, id >> 8], fields });

const SENSOR = { 0: 'ok', 85: 'circuit', 170: 'cutoff' };

const READS = {
  status01: {
    pbsb: 0xB511, data: [0x01],
    fields: [['flow', 'D1C'], ['return', 'D1C'], ['outdoor', 'D2B'], ['hwc', 'D1C'], ['storage', 'D1C'], ['pump', 'UCH']],
  },
  status02: {
    pbsb: 0xB511, data: [0x02],
    fields: [['hwcMode', 'UCH'], ['hwcMaxTemp', 'UCH'], ['hwcCurrent', 'D1C'], ['hcMaxTemp', 'UCH'], ['hcCurrent', 'D1C']],
  },
  flowTemp:          reg(0x0018, [['value', 'D2C'], ['sensor', 'UCH']]),
  returnTemp:        reg(0x0098, [['value', 'D2C'], [null, 'UIN'], ['sensor', 'UCH']]),
  hwcTemp:           reg(0x0016, [['value', 'D2C'], ['sensor', 'UCH']]),
  flowTempDesired:   reg(0x0039, [['value', 'D2C']]),
  storageTempDesired: reg(0x0004, [['value', 'D2C']]),
  waterPressure:     reg(0x0002, [['value', 'FLT'], ['sensor', 'UCH']]),
  flame:             reg(0x0005, [['value', 'UCH']]),
  modulation:        reg(0x002E, [['value', 'SIN', 10]]), // setpoint, see Boiler.poll()
  hwcDemand:         reg(0x0058, [['value', 'UCH']]),
  roomThermostat:    reg(0x000E, [['value', 'UCH']]),
  stateNumber:       reg(0x00AB, [['value', 'UCH']]),
  currentError: {
    pbsb: 0xB503, data: [0x00, 0x01],
    fields: [['e0', 'UIN'], ['e1', 'UIN'], ['e2', 'UIN'], ['e3', 'UIN'], ['e4', 'UIN']],
  },
};

function decodeRead(name, data) {
  return decode(data, READS[name].fields);
}

const HC_MODE = { auto: 0, off: 1, heat: 2, water: 3 };

/**
 * B510 00 SetMode — what a VRC controller sends to the boiler periodically.
 * 00 hcmode flowT hwcT hwcflowT ign disableBits ign remoteBits
 */
function setModeData({
  hcMode = 'auto', flowTemp, hwcTemp, disableHc = false, disableHwc = false,
}) {
  const bits = (disableHc ? 1 : 0) | (disableHwc ? 0b110 : 0);
  return [
    0x00,
    HC_MODE[hcMode] ?? 0,
    ...types.D1C.enc(flowTemp),
    ...types.D1C.enc(hwcTemp),
    0xFF,
    0xFF,
    bits,
    0x00,
    0x00,
  ];
}

module.exports = {
  BAI, READS, SENSOR, decodeRead, setModeData, SETMODE_PBSB: 0xB510,
};
