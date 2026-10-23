'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Indicators = require('../lib/Indicators');

function fakeBridge(caps) {
  const calls = [];
  return {
    calls,
    async getDeviceCapabilities(id) { return caps[id] || []; },
    async setCapabilities(id, values) { calls.push({ id, ...values }); },
  };
}

function fakeClock() {
  let seq = 0; const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fire() { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } },
    pending() { return timers.size; },
  };
}

test('sirens switch on with the alarm and off afterwards', async () => {
  const bridge = fakeBridge({});
  const clock = fakeClock();
  const ind = new Indicators({ bridge, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await ind.configure({ sirens: ['s1', 's2'] });
  await ind.setSirens(true);
  await ind.setSirens(false);
  assert.deepEqual(bridge.calls, [
    { id: 's1', onoff: true }, { id: 's2', onoff: true },
    { id: 's1', onoff: false }, { id: 's2', onoff: false },
  ]);
});

test('a fast on/off sequence ends with sirens off, never on', async () => {
  const bridge = fakeBridge({});
  const clock = fakeClock();
  const ind = new Indicators({ bridge, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await ind.configure({ sirens: ['slow', 's2'] });
  const p1 = ind.setSirens(true);   // superseded before it runs
  const p2 = ind.setSirens(false);
  await Promise.all([p1, p2]);
  assert.ok(bridge.calls.length > 0);
  assert.ok(bridge.calls.every(c => c.onoff === false));
});

test('LED follows the state and disarmed turns off after the delay', async () => {
  const bridge = fakeBridge({ led: ['onoff', 'dim', 'light_hue', 'light_saturation', 'light_mode'] });
  const clock = fakeClock();
  const ind = new Indicators({ bridge, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await ind.configure({ leds: { devices: ['led'], disarmedOffAfter: 20, armedOffAfter: 0 } });

  await ind.applyLed({ mode: 'armed', phase: 'armed' });
  assert.deepEqual(bridge.calls.at(-1), { id: 'led', onoff: true, light_mode: 'color', light_hue: 0, light_saturation: 1, dim: 1 });
  assert.equal(clock.pending(), 0); // armed stays on

  await ind.applyLed({ mode: 'armed', phase: 'armed' }); // unchanged -> no call
  assert.equal(bridge.calls.length, 1);

  await ind.applyLed({ mode: 'armed', phase: 'entry' });
  assert.equal(bridge.calls.at(-1).light_hue, 0.15); // countdown yellow

  await ind.applyLed({ mode: 'disarmed', phase: 'idle' });
  assert.equal(bridge.calls.at(-1).light_hue, 0.33); // green
  assert.equal(clock.pending(), 1);
  clock.fire();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(bridge.calls.at(-1), { id: 'led', onoff: false });
});

test('a colour set to off turns the light off, and only supported capabilities are sent', async () => {
  const bridge = fakeBridge({ bulb: ['onoff', 'dim'] });
  const clock = fakeClock();
  const ind = new Indicators({ bridge, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await ind.configure({ leds: { devices: ['bulb'], colors: { partially_armed: null }, brightness: 0.5 } });
  await ind.applyLed({ mode: 'partially_armed', phase: 'armed' });
  assert.deepEqual(bridge.calls.at(-1), { id: 'bulb', onoff: false });
  await ind.applyLed({ mode: 'armed', phase: 'alarm' });
  assert.deepEqual(bridge.calls.at(-1), { id: 'bulb', onoff: true, dim: 0.5 });
});
