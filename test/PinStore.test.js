'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const PinStore = require('../lib/PinStore');

function fakeSettings() {
  const store = new Map();
  return { get: k => store.get(k), set: (k, v) => store.set(k, v), unset: k => store.delete(k) };
}

test('replace hashes PINs and never returns them', async () => {
  const settings = fakeSettings();
  const pins = new PinStore({ settings });
  const list = await pins.replace([{ name: 'Alice', pin: '1234' }, { name: 'Bob', pin: '567890', canArm: false }]);
  assert.equal(list.length, 2);
  assert.ok(list.every(u => u.hasPin && u.pin === undefined));
  const raw = settings.get('users');
  assert.ok(raw.every(u => !('pin' in u) && u.hash.length === 64 && u.salt.length === 32));
  assert.ok(!JSON.stringify(raw).includes('1234'));
});

test('verify returns the matching user and permissions', async () => {
  const pins = new PinStore({ settings: fakeSettings() });
  await pins.replace([{ name: 'Alice', pin: '1234' }, { name: 'Bob', pin: '567890', canArm: false }]);
  const a = await pins.verify('1234', 'w1');
  assert.equal(a.ok, true);
  assert.equal(a.user.name, 'Alice');
  const b = await pins.verify('567890', 'w1');
  assert.equal(b.user.name, 'Bob');
  assert.equal(b.user.canArm, false);
  const bad = await pins.verify('0000', 'w1');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid');
});

test('existing PIN is kept when pin is omitted on replace', async () => {
  const pins = new PinStore({ settings: fakeSettings() });
  const [alice] = await pins.replace([{ name: 'Alice', pin: '1234' }]);
  await pins.replace([{ id: alice.id, name: 'Alice renamed' }]);
  assert.equal((await pins.verify('1234')).ok, true);
});

test('lockout after 5 failures, per client, with escalation', async () => {
  const pins = new PinStore({ settings: fakeSettings() });
  await pins.replace([{ name: 'Alice', pin: '1234' }]);
  for (let i = 0; i < 4; i++) assert.equal((await pins.verify('0000', 'tablet')).reason, 'invalid');
  const locked = await pins.verify('0000', 'tablet');
  assert.equal(locked.reason, 'locked');
  assert.equal(locked.retryAfter, 30);
  // the right PIN is also refused while locked
  assert.equal((await pins.verify('1234', 'tablet')).reason, 'locked');
  // another client is unaffected (below the global threshold)
  assert.equal((await pins.verify('1234', 'phone')).ok, true);
});

test('global lockout defeats rotating client ids', async () => {
  const pins = new PinStore({ settings: fakeSettings() });
  await pins.replace([{ name: 'Alice', pin: '1234' }]);
  let last;
  for (let i = 0; i < 15; i++) last = await pins.verify('0000', `client-${i}`);
  assert.equal(last.reason, 'locked');
  // even a brand new client with the right PIN is locked out now
  const r = await pins.verify('1234', 'fresh-client');
  assert.equal(r.reason, 'locked');
});

test('disabled user and empty store are reported safely', async () => {
  const pins = new PinStore({ settings: fakeSettings() });
  assert.equal((await pins.verify('1234')).reason, 'no_users');
  await pins.replace([{ name: 'Alice', pin: '1234', enabled: false }]);
  // a disabled user's real PIN looks like a wrong PIN and counts as a failure
  const r = await pins.verify('1234', 'c');
  assert.equal(r.reason, 'invalid');
  assert.equal(r.attemptsLeft, 4);
});

test('panic suffix: PIN + suffix verifies as the user with panic flag', async () => {
  const pins = new PinStore({ settings: fakeSettings() });
  await pins.replace([{ name: 'Alice', pin: '1234' }]);
  const normal = await pins.verify('1234', 'w', { panicSuffix: '9' });
  assert.equal(normal.ok, true);
  assert.equal(normal.panic, false);
  const panic = await pins.verify('12349', 'w', { panicSuffix: '9' });
  assert.equal(panic.ok, true);
  assert.equal(panic.panic, true);
  assert.equal(panic.user.name, 'Alice');
  // without suffix configured the same entry is just a wrong PIN
  assert.equal((await pins.verify('12349', 'w')).ok, false);
  // a panic entry does not count as a failed attempt
  for (let i = 0; i < 10; i++) await pins.verify('12349', 'w', { panicSuffix: '9' });
  assert.equal((await pins.verify('1234', 'w', { panicSuffix: '9' })).ok, true);
});

test('replace rejects PINs that collide with other users, including panic ambiguity', async () => {
  const pins = new PinStore({ settings: fakeSettings() });
  const [alice] = await pins.replace([{ name: 'Alice', pin: '1234' }], { panicSuffix: '9' });
  // same PIN as an existing (hashed) user
  await assert.rejects(pins.replace([{ id: alice.id, name: 'Alice' }, { name: 'Bob', pin: '1234' }], { panicSuffix: '9' }), /same as, or too similar/);
  // Bob's PIN equals Alice's PIN + panic suffix
  await assert.rejects(pins.replace([{ id: alice.id, name: 'Alice' }, { name: 'Bob', pin: '12349' }], { panicSuffix: '9' }), /same as, or too similar/);
  // Bob's PIN + suffix equals Alice's PIN (Alice=1234, Bob=123 is too short anyway; use 5-digit Alice)
  const store2 = new PinStore({ settings: fakeSettings() });
  const [carol] = await store2.replace([{ name: 'Carol', pin: '56789' }], { panicSuffix: '9' });
  await assert.rejects(store2.replace([{ id: carol.id, name: 'Carol' }, { name: 'Dave', pin: '5678' }], { panicSuffix: '9' }), /same as, or too similar/);
  // two new PINs ambiguous with each other
  await assert.rejects(new PinStore({ settings: fakeSettings() }).replace([{ name: 'A', pin: '1234' }, { name: 'B', pin: '12349' }], { panicSuffix: '9' }), /ambiguous|too similar/);
  // unrelated PIN is fine
  const ok = await pins.replace([{ id: alice.id, name: 'Alice' }, { name: 'Bob', pin: '4321' }], { panicSuffix: '9' });
  assert.equal(ok.length, 2);
});

test('validation errors', async () => {
  const pins = new PinStore({ settings: fakeSettings() });
  await assert.rejects(pins.replace([{ name: 'A', pin: '12' }]), /4 to 8 digits/);
  await assert.rejects(pins.replace([{ name: 'A', pin: '1234' }, { name: 'B', pin: '1234' }]), /share/);
  await assert.rejects(pins.replace([{ name: 'A' }]), /no PIN/);
});

test('verifications are serialised and never overlap', async () => {
  const pins = new PinStore({ settings: fakeSettings() });
  await pins.replace([{ name: 'Alice', pin: '1234' }]);
  const results = await Promise.all([pins.verify('1234', 'a'), pins.verify('0000', 'b'), pins.verify('1234', 'c')]);
  assert.deepEqual(results.map(r => r.ok), [true, false, true]);
});
