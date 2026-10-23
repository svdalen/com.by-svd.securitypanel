'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/ringIndicators');

test('indicatorSet builds a v2 Indicator Set frame', () => {
  const cmd = R.indicatorSet([{ id: 0x0b }]);
  assert.equal(cmd.commandClassId, 0x87);
  assert.equal(cmd.commandId, 0x01);
  assert.deepEqual([...cmd.params], [0x00, 0x01, 0x0b, 0x02, 0xff]);
});

test('mode, delay, alarm, feedback and chime payloads', () => {
  assert.deepEqual([...R.modeIndicator('armed').params], [0, 1, 0x0b, 0x02, 0xff]);
  assert.deepEqual([...R.modeIndicator('partially_armed').params], [0, 1, 0x0a, 0x02, 0xff]);
  assert.deepEqual([...R.modeIndicator('disarmed').params], [0, 1, 0x02, 0x02, 0xff]);
  assert.deepEqual([...R.delayIndicator('exit', 30).params], [0, 1, 0x12, 0x07, 30]);
  assert.deepEqual([...R.delayIndicator('entry', 300).params], [0, 1, 0x11, 0x07, 255]); // clamped
  assert.deepEqual([...R.alarmIndicator('burglar').params], [0, 1, 0x0d, 0x02, 0xff]);
  assert.deepEqual([...R.alarmIndicator('burglar', false).params], [0, 1, 0x0d, 0x02, 0x00]);
  assert.deepEqual([...R.feedbackIndicator(true).params], [0, 1, 0x08, 0x02, 0xff]);
  assert.deepEqual([...R.feedbackIndicator(false).params], [0, 1, 0x09, 0x02, 0xff]);
  assert.deepEqual([...R.chimeIndicator('bingbong', 5).params], [0, 1, 0x63, 0x09, 100]);
  assert.deepEqual([...R.chimeIndicator('unknown', 0).params], [0, 1, 0x60, 0x09, 20]);
});

test('decodeEntryCode handles Buffer, serialised Buffer and strings', () => {
  assert.equal(R.decodeEntryCode(Buffer.from('1234', 'ascii')), '1234');
  assert.equal(R.decodeEntryCode({ type: 'Buffer', data: [0x35, 0x36, 0x37, 0x38] }), '5678');
  assert.equal(R.decodeEntryCode('12-34'), '1234');
  assert.equal(R.decodeEntryCode(undefined), '');
  assert.equal(R.decodeEntryCode(Buffer.alloc(0)), '');
});
