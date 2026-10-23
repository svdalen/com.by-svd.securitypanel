'use strict';

/**
 * Z-Wave Indicator Command Class (0x87) helpers for the Ring Keypad.
 *
 * Indicator Set (v2+) frame layout:
 *   [Indicator 0 value][object count][(indicator id, property id, value) x count]
 *
 * Indicator ids and property ids follow the Z-Wave specification; the Ring
 * Keypad uses the standard security-panel indicators for its lights and
 * sounds. Nothing here talks to the network, so it can be unit tested.
 */
const COMMAND_CLASS_INDICATOR = 0x87;
const INDICATOR_SET = 0x01;

const IND = Object.freeze({
  NOT_ARMED: 0x02,       // "Disarmed" light
  OK: 0x08,              // green check feedback
  NOT_OK: 0x09,          // red cross feedback
  ARMED_HOME: 0x0a,
  ARMED_AWAY: 0x0b,
  ALARM_GENERIC: 0x0c,
  ALARM_BURGLAR: 0x0d,
  ALARM_SMOKE: 0x0e,
  ALARM_CO: 0x0f,
  BYPASS: 0x10,          // "sensor bypassed / open" indication
  ENTRY_DELAY: 0x11,
  EXIT_DELAY: 0x12,
  ALARM_MEDICAL: 0x13,
  CHIME_DOUBLE_BEEP: 0x60,
  CHIME_GUITAR_RIFF: 0x61,
  CHIME_WIND_CHIMES: 0x62,
  CHIME_BING_BONG: 0x63,
  CHIME_RING_DEFAULT: 0x64,
});

const PROP = Object.freeze({
  MULTILEVEL: 0x01,
  BINARY: 0x02,
  DURATION: 0x07, // seconds, used for the exit/entry delay light bar
  VOLUME: 0x09,   // 0..100 for chimes
});

const ON = 0xff;
const OFF = 0x00;

const CHIMES = Object.freeze({
  doublebeep: IND.CHIME_DOUBLE_BEEP,
  guitarriff: IND.CHIME_GUITAR_RIFF,
  windchimes: IND.CHIME_WIND_CHIMES,
  bingbong: IND.CHIME_BING_BONG,
  ringdefault: IND.CHIME_RING_DEFAULT,
});

const ALARMS = Object.freeze({
  burglar: IND.ALARM_BURGLAR,
  smoke: IND.ALARM_SMOKE,
  co: IND.ALARM_CO,
  medical: IND.ALARM_MEDICAL,
  generic: IND.ALARM_GENERIC,
});

/**
 * Build an Indicator Set command.
 * @param {Array<{id:number, property?:number, value?:number}>} objects
 * @returns {{ commandClassId:number, commandId:number, params:Buffer }}
 */
function indicatorSet(objects) {
  if (!Array.isArray(objects) || objects.length === 0 || objects.length > 31) {
    throw new Error('indicatorSet needs 1..31 indicator objects');
  }
  const bytes = [OFF, objects.length & 0x1f];
  for (const o of objects) {
    bytes.push(o.id & 0xff, (o.property === undefined ? PROP.BINARY : o.property) & 0xff, (o.value === undefined ? ON : o.value) & 0xff);
  }
  return { commandClassId: COMMAND_CLASS_INDICATOR, commandId: INDICATOR_SET, params: Buffer.from(bytes) };
}

/** Light for a panel mode. */
function modeIndicator(mode) {
  if (mode === 'armed') return indicatorSet([{ id: IND.ARMED_AWAY }]);
  if (mode === 'partially_armed') return indicatorSet([{ id: IND.ARMED_HOME }]);
  return indicatorSet([{ id: IND.NOT_ARMED }]);
}

/** Longest countdown the keypad's duration byte can express. */
const MAX_DELAY_SECONDS = 255;

/** Exit or entry delay light bar (and the keypad's own countdown sound) for n seconds. */
function delayIndicator(type, seconds) {
  const id = type === 'entry' ? IND.ENTRY_DELAY : IND.EXIT_DELAY;
  const s = Math.max(1, Math.min(MAX_DELAY_SECONDS, Math.round(seconds)));
  return indicatorSet([{ id, property: PROP.DURATION, value: s }]);
}

/** Alarm light + siren. `kind` is one of ALARMS keys; `on` false switches it off. */
function alarmIndicator(kind, on = true) {
  const id = ALARMS[kind] || ALARMS.burglar;
  return indicatorSet([{ id, value: on ? ON : OFF }]);
}

function feedbackIndicator(ok) {
  return indicatorSet([{ id: ok ? IND.OK : IND.NOT_OK }]);
}

function bypassIndicator() {
  return indicatorSet([{ id: IND.BYPASS }]);
}

/** Play a chime at volume 1..5 (mapped to 0..100). */
function chimeIndicator(name, volume = 3) {
  const id = CHIMES[name] || CHIMES.doublebeep;
  const v = Math.max(1, Math.min(5, Math.round(volume)));
  return indicatorSet([{ id, property: PROP.VOLUME, value: v * 20 }]);
}

/**
 * Decode the code digits from an Entry Control Notification's "Event Data".
 * Homey hands it over as a Buffer or as a JSON-serialised Buffer.
 */
function decodeEntryCode(eventData) {
  let buf = null;
  if (Buffer.isBuffer(eventData)) buf = eventData;
  else if (eventData && Array.isArray(eventData.data)) buf = Buffer.from(eventData.data);
  else if (typeof eventData === 'string') return eventData.replace(/\D/g, '');
  if (!buf) return '';
  return buf.toString('ascii').replace(/\D/g, '');
}

module.exports = {
  COMMAND_CLASS_INDICATOR, INDICATOR_SET, IND, PROP, ON, OFF, CHIMES, ALARMS, MAX_DELAY_SECONDS,
  indicatorSet, modeIndicator, delayIndicator, alarmIndicator, feedbackIndicator, bypassIndicator, chimeIndicator,
  decodeEntryCode,
};
