'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const AlarmEngine = require('../lib/AlarmEngine');

/** Deterministic fake timers. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        now = next.t.at;
        timers.delete(next.id);
        next.t.fn();
      }
      now = target;
    },
  };
}

function make(config = {}) {
  const clock = fakeClock();
  const engine = new AlarmEngine({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  engine.setConfig({ exitDelay: 10, entryDelay: 5, alarmDuration: 60, preArmCheck: 'block', ...config });
  engine.setSensors([
    { id: 'door', name: 'Front door', capability: 'alarm_contact', modes: ['armed', 'partially_armed'], entryDelay: true },
    { id: 'pir', name: 'Living PIR', capability: 'alarm_motion', modes: ['armed'], entryDelay: false },
  ]);
  const events = [];
  for (const ev of ['mode', 'phase', 'arming', 'armBlocked', 'armWarning', 'tick', 'entry', 'alarm', 'alarmEnded', 'countdownCancelled', 'sensorEnabled']) {
    engine.on(ev, data => events.push({ ev, ...data }));
  }
  return { engine, clock, events };
}

test('arming runs the exit delay then applies the mode', () => {
  const { engine, clock, events } = make();
  const res = engine.requestMode('armed', { source: 'widget', user: 'Alice' });
  assert.equal(res.ok, true);
  assert.equal(res.delayed, true);
  assert.equal(engine.phase, 'arming');
  assert.equal(engine.mode, 'disarmed');

  clock.advance(9_000);
  assert.equal(engine.mode, 'disarmed');
  assert.equal(engine.countdown.seconds, 1);

  clock.advance(1_000);
  assert.equal(engine.mode, 'armed');
  assert.equal(engine.phase, 'armed');
  const ticks = events.filter(e => e.ev === 'tick');
  assert.equal(ticks.length, 10);
  assert.equal(ticks[0].seconds, 10);
  assert.equal(ticks[9].seconds, 1);
  const modeEv = events.find(e => e.ev === 'mode');
  assert.deepEqual({ mode: modeEv.mode, user: modeEv.user, source: modeEv.source }, { mode: 'armed', user: 'Alice', source: 'widget' });
});

test('without exit delay an open sensor blocks arming immediately (block)', () => {
  const { engine, events } = make({ exitDelay: 0 });
  engine.onSensorValue('door', true);
  const res = engine.requestMode('armed');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'sensors_open');
  assert.equal(res.sensors[0].name, 'Front door');
  assert.equal(engine.phase, 'idle');
  assert.ok(events.some(e => e.ev === 'armBlocked' && e.stage === 'immediate'));
});

test('with exit delay: arming starts even with an open door, and arms when it closed in time', () => {
  const { engine, clock, events } = make();
  engine.onSensorValue('door', true);
  const res = engine.requestMode('armed', { source: 'widget', user: 'Alice' });
  assert.equal(res.ok, true);
  assert.equal(res.delayed, true);
  assert.deepEqual(res.openSensors.map(s => s.name), ['Front door']);
  assert.equal(engine.phase, 'arming');
  const arming = events.find(e => e.ev === 'arming');
  assert.deepEqual(arming.openSensors.map(s => s.name), ['Front door']);
  clock.advance(6_000);
  engine.onSensorValue('door', false); // walked out and closed the door
  clock.advance(4_000);
  assert.equal(engine.mode, 'armed');
  assert.equal(engine.phase, 'armed');
  assert.ok(!events.some(e => e.ev === 'armBlocked'));
});

test('with exit delay: a door still open at the end blocks, system stays disarmed', () => {
  const { engine, clock, events } = make();
  engine.onSensorValue('door', true);
  engine.requestMode('armed');
  clock.advance(10_000);
  assert.equal(engine.mode, 'disarmed');
  assert.equal(engine.phase, 'idle');
  const blocked = events.find(e => e.ev === 'armBlocked');
  assert.equal(blocked.stage, 'end');
  assert.equal(blocked.sensors[0].name, 'Front door');
  assert.equal(engine.getStatus().lastArmBlocked.sensors[0].name, 'Front door');
  assert.ok(events.some(e => e.ev === 'mode' && e.cancelled));
  // a later successful arm clears the block info
  engine.onSensorValue('door', false);
  engine.requestMode('armed');
  clock.advance(10_000);
  assert.equal(engine.mode, 'armed');
  assert.equal(engine.getStatus().lastArmBlocked, null);
});

test('open sensor only warns when preArmCheck=warn', () => {
  const { engine, clock, events } = make({ preArmCheck: 'warn' });
  engine.onSensorValue('door', true);
  const res = engine.requestMode('armed');
  assert.equal(res.ok, true);
  clock.advance(10_000);
  assert.equal(engine.mode, 'armed');
  assert.ok(events.some(e => e.ev === 'armWarning' && e.stage === 'end'));
});

test('end-of-delay check ignores motion sensors by default, unless the option is off', () => {
  // default: endCheckContactOnly = true -> active PIR does not block at the end
  let t = make();
  t.engine.requestMode('armed');
  t.clock.advance(5_000);
  t.engine.onSensorValue('pir', true); // walked past it, still "active" at the end
  t.clock.advance(5_000);
  assert.equal(t.engine.mode, 'armed');

  // a door still open does block, even with the option on
  t = make();
  t.engine.onSensorValue('door', true);
  t.engine.requestMode('armed');
  t.clock.advance(10_000);
  assert.equal(t.engine.mode, 'disarmed');

  // option off: the PIR blocks too
  t = make({ endCheckContactOnly: false });
  t.engine.requestMode('armed');
  t.clock.advance(5_000);
  t.engine.onSensorValue('pir', true);
  t.clock.advance(5_000);
  assert.equal(t.engine.mode, 'disarmed');
  assert.equal(t.engine.getStatus().lastArmBlocked.sensors[0].name, 'Living PIR');

  // without exit delay the immediate check still counts motion sensors
  t = make({ exitDelay: 0 });
  t.engine.onSensorValue('pir', true);
  assert.equal(t.engine.requestMode('armed').ok, false);
});

test('preArmCheck=off never checks', () => {
  const { engine, clock } = make({ preArmCheck: 'off' });
  engine.onSensorValue('door', true);
  engine.requestMode('armed');
  clock.advance(10_000);
  assert.equal(engine.mode, 'armed');
});

test('open sensor not in the requested mode does not block', () => {
  const { engine } = make({ exitDelay: 0 });
  engine.onSensorValue('pir', true); // pir only in "armed"
  const res = engine.requestMode('partially_armed');
  assert.equal(res.ok, true);
  assert.equal(engine.mode, 'partially_armed');
});

test('sensors tripping during the exit delay are ignored', () => {
  const { engine, clock } = make();
  engine.requestMode('armed');
  clock.advance(2_000);
  engine.onSensorValue('door', true);
  engine.onSensorValue('door', false);
  assert.equal(engine.phase, 'arming');
  clock.advance(8_000);
  assert.equal(engine.mode, 'armed');
  assert.equal(engine.phase, 'armed');
});

test('delayed sensor starts entry delay, then alarm', () => {
  const { engine, clock, events } = make({ exitDelay: 0 });
  engine.requestMode('armed');
  engine.onSensorValue('door', true);
  assert.equal(engine.phase, 'entry');
  assert.ok(events.some(e => e.ev === 'entry' && e.sensor.name === 'Front door' && e.seconds === 5));
  clock.advance(4_000);
  assert.equal(engine.phase, 'entry');
  clock.advance(1_000);
  assert.equal(engine.phase, 'alarm');
  const alarm = events.find(e => e.ev === 'alarm');
  assert.equal(alarm.sensor.name, 'Front door');
  assert.equal(engine.getStatus().alarmReason, 'Front door');
});

test('pending sensor is exposed during entry delay and cleared afterwards', () => {
  const { engine, clock } = make({ exitDelay: 0 });
  engine.requestMode('armed');
  engine.onSensorValue('door', true);
  const s = engine.getStatus();
  assert.equal(s.alarmPending, true);
  assert.equal(s.pendingSensor.name, 'Front door');
  clock.advance(5_000);
  assert.equal(engine.getStatus().alarmPending, false);
  assert.equal(engine.getStatus().pendingSensor, null);
  assert.equal(engine.getStatus().alarmActive, true);
});

test('disarming during entry delay prevents the alarm', () => {
  const { engine, clock, events } = make({ exitDelay: 0 });
  engine.requestMode('armed');
  engine.onSensorValue('door', true);
  clock.advance(3_000);
  engine.disarm({ source: 'widget', user: 'Bob' });
  clock.advance(10_000);
  assert.equal(engine.phase, 'idle');
  assert.equal(engine.mode, 'disarmed');
  assert.ok(!events.some(e => e.ev === 'alarm'));
  assert.ok(events.some(e => e.ev === 'countdownCancelled' && e.type === 'entry'));
});

test('instant sensor triggers the alarm immediately', () => {
  const { engine } = make({ exitDelay: 0 });
  engine.requestMode('armed');
  engine.onSensorValue('pir', true);
  assert.equal(engine.phase, 'alarm');
});

test('sensor outside the current mode does not trigger', () => {
  const { engine } = make({ exitDelay: 0 });
  engine.requestMode('partially_armed');
  engine.onSensorValue('pir', true); // pir only in "armed"
  assert.equal(engine.phase, 'armed');
});

test('alarm times out after alarmDuration and stays armed', () => {
  const { engine, clock, events } = make({ exitDelay: 0, alarmDuration: 30 });
  engine.requestMode('armed');
  engine.onSensorValue('pir', true);
  clock.advance(30_000);
  assert.equal(engine.phase, 'armed');
  assert.equal(engine.mode, 'armed');
  assert.ok(events.some(e => e.ev === 'alarmEnded' && e.reason === 'timeout'));
});

test('alarmDuration 0 keeps the alarm until disarmed', () => {
  const { engine, clock } = make({ exitDelay: 0, alarmDuration: 0 });
  engine.requestMode('armed');
  engine.onSensorValue('pir', true);
  clock.advance(3_600_000);
  assert.equal(engine.phase, 'alarm');
  engine.disarm();
  assert.equal(engine.phase, 'idle');
});

test('deactivateAlarm silences but stays armed', () => {
  const { engine, events } = make({ exitDelay: 0 });
  engine.requestMode('armed');
  engine.onSensorValue('pir', true);
  assert.equal(engine.deactivateAlarm({ source: 'widget', user: 'Alice' }), true);
  assert.equal(engine.phase, 'armed');
  assert.equal(engine.mode, 'armed');
  assert.ok(events.some(e => e.ev === 'alarmEnded' && e.reason === 'deactivated' && e.user === 'Alice'));
  // re-trip -> alarm again
  engine.onSensorValue('pir', false);
  engine.onSensorValue('pir', true);
  assert.equal(engine.phase, 'alarm');
});

test('disarm during exit delay cancels arming', () => {
  const { engine, clock, events } = make();
  engine.requestMode('armed');
  clock.advance(3_000);
  engine.disarm({ source: 'widget' });
  clock.advance(20_000);
  assert.equal(engine.mode, 'disarmed');
  assert.equal(engine.phase, 'idle');
  assert.ok(events.some(e => e.ev === 'countdownCancelled' && e.type === 'exit'));
});

test('immediate flag skips delay and check (linked panel)', () => {
  const { engine } = make();
  engine.onSensorValue('door', true);
  const res = engine.requestMode('armed', { source: 'panel', immediate: true, skipCheck: true });
  assert.equal(res.ok, true);
  assert.equal(engine.mode, 'armed');
});

test('restore fails safe: interrupted entry delay becomes alarm', () => {
  const { engine } = make();
  engine.restore({ mode: 'armed', phase: 'entry' });
  assert.equal(engine.mode, 'armed');
  assert.equal(engine.phase, 'alarm');
  engine.restore({ mode: 'armed', phase: 'arming' });
  assert.equal(engine.phase, 'armed');
  engine.restore({ mode: 'disarmed', phase: 'alarm' });
  assert.equal(engine.phase, 'idle');
});

test('setSensors keeps the active flag of existing sensors', () => {
  const { engine } = make();
  engine.onSensorValue('door', true);
  engine.setSensors([{ id: 'door', name: 'Front door', modes: ['armed'] }]);
  assert.equal(engine.getActiveSensors().length, 1);
});

test('excluded sensor neither blocks arming nor triggers', () => {
  const { engine, events } = make({ exitDelay: 0 });
  engine.onSensorValue('door', true);          // door is open
  assert.equal(engine.setSensorEnabled('door', false), true);
  assert.ok(events.some(e => e.ev === 'sensorEnabled' && e.id === 'door' && e.enabled === false));
  assert.equal(engine.getActiveSensors().length, 0);
  assert.deepEqual(engine.getStatus().excludedSensors, [{ id: 'door', name: 'Front door' }]);

  assert.equal(engine.requestMode('armed').ok, true); // not blocked
  engine.onSensorValue('door', false);
  engine.onSensorValue('door', true);
  assert.equal(engine.phase, 'armed');               // no entry delay, no alarm

  engine.setSensorEnabled('door', true);
  engine.onSensorValue('door', false);
  engine.onSensorValue('door', true);
  assert.equal(engine.phase, 'entry');               // included again
  assert.equal(engine.setSensorEnabled('nope', false), false);
});

test('enabled flag is read from config and survives setSensors', () => {
  const { engine } = make();
  engine.setSensors([{ id: 'door', name: 'Front door', modes: ['armed'], enabled: false }]);
  assert.equal(engine.isSensorEnabled('door'), false);
  assert.equal(engine.listSensors()[0].enabled, false);
});

test('home (partial) arming uses its own exit delay, none by default', () => {
  const { engine, clock } = make(); // exitDelay 10, exitDelayHome default 0
  engine.requestMode('partially_armed');
  assert.equal(engine.mode, 'partially_armed'); // immediate
  engine.disarm();
  engine.setConfig({ exitDelayHome: 5 });
  const res = engine.requestMode('partially_armed');
  assert.equal(res.delayed, true);
  assert.equal(res.seconds, 5);
  clock.advance(5_000);
  assert.equal(engine.mode, 'partially_armed');
  // away arming still uses exitDelay
  engine.disarm();
  assert.equal(engine.requestMode('armed').seconds, 10);
});

test('re-requesting the current armed mode is a no-op (no blind window, no duplicate events)', () => {
  const { engine, clock, events } = make({ exitDelay: 0 });
  engine.requestMode('armed');
  const before = events.length;
  engine.setConfig({ exitDelay: 10 });
  const res = engine.requestMode('armed');
  assert.equal(res.ok, true);
  assert.equal(res.unchanged, true);
  assert.equal(engine.phase, 'armed');
  assert.equal(events.length, before);
  engine.onSensorValue('pir', true); // still detecting
  assert.equal(engine.phase, 'alarm');
  clock.advance(0);
});

test('arming while the alarm sounds ends the alarm properly, then arms (verified user only)', () => {
  const { engine, clock, events } = make({ exitDelay: 0 });
  engine.requestMode('armed');
  engine.onSensorValue('pir', true);
  assert.equal(engine.phase, 'alarm');
  // without a verified user (flow, tile, API) the request is refused and the alarm keeps sounding
  const refused = engine.requestMode('partially_armed', { source: 'flow' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'alarm_active');
  assert.equal(engine.phase, 'alarm');
  engine.onSensorValue('pir', false);
  const res = engine.requestMode('partially_armed', { source: 'keypad', user: 'Alice' });
  assert.equal(res.ok, true);
  assert.equal(engine.phase, 'armed');
  assert.equal(engine.mode, 'partially_armed');
  assert.equal(engine.getStatus().alarmReason, null);
  assert.ok(events.some(e => e.ev === 'alarmEnded' && e.reason === 'rearmed'));
  clock.advance(120_000); // no stray alarm timeout events
  assert.equal(engine.phase, 'armed');
});

test('arming during an entry countdown needs a verified user; then cancels it and clears the pending sensor', () => {
  const { engine, clock, events } = make({ exitDelay: 0 });
  engine.requestMode('armed');
  engine.onSensorValue('door', true);
  assert.equal(engine.phase, 'entry');
  const refused = engine.requestMode('partially_armed', { source: 'flow' });
  assert.equal(refused.reason, 'alarm_pending');
  assert.equal(engine.phase, 'entry'); // intrusion still pending
  engine.onSensorValue('door', false);
  engine.requestMode('partially_armed', { source: 'keypad', user: 'Alice' });
  assert.equal(engine.phase, 'armed');
  assert.equal(engine.getStatus().pendingSensor, null);
  assert.ok(events.some(e => e.ev === 'countdownCancelled' && e.type === 'entry'));
  clock.advance(10_000);
  assert.equal(engine.phase, 'armed'); // the old entry timer is gone
});

test('resumeIfAlarm re-announces a restored alarm and restarts its timeout', () => {
  const { engine, clock, events } = make({ alarmDuration: 30 });
  engine.restore({ mode: 'armed', phase: 'entry', alarmReason: 'Front door' });
  assert.equal(engine.resumeIfAlarm(), true);
  assert.ok(events.some(e => e.ev === 'alarm' && e.restored && e.reason === 'Front door'));
  clock.advance(30_000);
  assert.equal(engine.phase, 'armed');
  assert.ok(events.some(e => e.ev === 'alarmEnded' && e.reason === 'timeout'));
  // not in alarm: nothing happens
  assert.equal(engine.resumeIfAlarm(), false);
});

test('seeded sensor values update state without tripping', () => {
  const { engine } = make({ exitDelay: 0 });
  engine.requestMode('armed');
  engine.onSensorValue('pir', true, { seed: true });
  assert.equal(engine.phase, 'armed');
  assert.equal(engine.getActiveSensors().length, 1);
  engine.onSensorValue('pir', false);
  engine.onSensorValue('pir', true); // a real trip still works
  assert.equal(engine.phase, 'alarm');
});

test('lastActiveAt is set on a real trip, not on a seeded value', () => {
  const { engine } = make({ exitDelay: 0 });
  engine.onSensorValue('pir', true, { seed: true });
  assert.equal(engine.listSensors().find(s => s.id === 'pir').lastActiveAt || null, null);
  engine.onSensorValue('pir', false);
  const before = Date.now();
  engine.onSensorValue('pir', true);
  const at = engine.listSensors().find(s => s.id === 'pir').lastActiveAt;
  assert.ok(typeof at === 'number' && at >= before);
});

test('a seeded value carries Homey lastUpdated timestamp into lastChangedAt / lastActiveAt', () => {
  const { engine } = make({ exitDelay: 0 });
  const at = Date.now() - 3600000;
  engine.onSensorValue('pir', true, { seed: true, at });
  let s = engine.listSensors().find(x => x.id === 'pir');
  assert.equal(s.lastChangedAt, at);
  assert.equal(s.lastActiveAt, at);
  assert.equal(engine.phase, 'idle'); // still no trip
  engine.onSensorValue('pir', false);
  s = engine.listSensors().find(x => x.id === 'pir');
  assert.ok(s.lastChangedAt > at);
  assert.equal(s.lastActiveAt, at);
  // a seeded false value only dates the change
  engine.onSensorValue('door', false, { seed: true, at });
  s = engine.listSensors().find(x => x.id === 'door');
  assert.equal(s.lastChangedAt, at);
  assert.equal(s.lastActiveAt || null, null);
});

test('config sanitising keeps endCheckContactOnly a boolean defaulting to true', () => {
  const { engine } = make();
  engine.setConfig({ endCheckContactOnly: undefined });
  assert.equal(engine.config.endCheckContactOnly, true);
  engine.setConfig({ endCheckContactOnly: false });
  assert.equal(engine.config.endCheckContactOnly, false);
});

test('invalid mode is rejected', () => {
  const { engine } = make();
  assert.equal(engine.requestMode('bogus').ok, false);
});
