'use strict';

/**
 * Maps the "action key" a physical keypad reports to a panel action.
 *
 * Z-Wave Entry Control keypads (Ring Keypad via the Ring Security app, and
 * others) report the raw Entry Control event type, e.g. DISARM_ALL, ARM_HOME,
 * ARM_AWAY, ENTER, CANCEL. Other apps use readable names such as "Disarm",
 * "Home", "Away", "Stay", "Arm". Matching is case-insensitive and tolerant.
 *
 * @param {string} key
 * @returns {'disarmed'|'armed'|'partially_armed'|'enter'|'cancel'|null}
 */
function mapKeypadKey(key) {
  const k = String(key || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!k) return null;
  if (/^(disarm|disarm_all|disarmed|off|unlock)$/.test(k)) return 'disarmed';
  if (/^(arm_home|home|stay|partial|partially_armed|arm_1|night)$/.test(k)) return 'partially_armed';
  if (/^(arm_away|arm_all|away|arm|armed|on|lock)$/.test(k)) return 'armed';
  if (/^(enter|ok|check|confirm|submit)$/.test(k)) return 'enter';
  if (/^(cancel|clear|esc|escape|x)$/.test(k)) return 'cancel';
  return null;
}

/**
 * Resolve the generic "enter" key into a concrete action for the current
 * panel state: anything not disarmed (or counting down) disarms, otherwise arm.
 */
function resolveEnter(status) {
  if (!status) return 'armed';
  if (status.phase === 'alarm' || status.phase === 'entry' || status.phase === 'arming') return 'disarmed';
  return status.mode === 'disarmed' ? 'armed' : 'disarmed';
}

module.exports = { mapKeypadKey, resolveEnter };
