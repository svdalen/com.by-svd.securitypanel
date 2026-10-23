'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapKeypadKey, resolveEnter } = require('../lib/keypadKeys');

test('Z-Wave Entry Control event types map to panel actions', () => {
  assert.equal(mapKeypadKey('DISARM_ALL'), 'disarmed');
  assert.equal(mapKeypadKey('ARM_HOME'), 'partially_armed');
  assert.equal(mapKeypadKey('ARM_AWAY'), 'armed');
  assert.equal(mapKeypadKey('ARM_ALL'), 'armed');
  assert.equal(mapKeypadKey('ENTER'), 'enter');
  assert.equal(mapKeypadKey('CANCEL'), 'cancel');
});

test('readable names and odd casing work too', () => {
  assert.equal(mapKeypadKey('Disarm'), 'disarmed');
  assert.equal(mapKeypadKey(' home '), 'partially_armed');
  assert.equal(mapKeypadKey('Away'), 'armed');
  assert.equal(mapKeypadKey('Arm Away'), 'armed');
  assert.equal(mapKeypadKey('Stay'), 'partially_armed');
  assert.equal(mapKeypadKey(''), null);
  assert.equal(mapKeypadKey('CACHING'), null);
  assert.equal(mapKeypadKey(undefined), null);
});

test('enter resolves against the current state', () => {
  assert.equal(resolveEnter({ mode: 'disarmed', phase: 'idle' }), 'armed');
  assert.equal(resolveEnter({ mode: 'armed', phase: 'armed' }), 'disarmed');
  assert.equal(resolveEnter({ mode: 'partially_armed', phase: 'armed' }), 'disarmed');
  assert.equal(resolveEnter({ mode: 'disarmed', phase: 'arming' }), 'disarmed');
  assert.equal(resolveEnter({ mode: 'armed', phase: 'alarm' }), 'disarmed');
});
