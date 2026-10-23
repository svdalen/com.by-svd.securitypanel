'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SETTINGS_KEY = 'users';
const SCRYPT_KEYLEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

const MAX_FAILURES = 5;         // per client, before a lockout starts
const GLOBAL_MAX_FAILURES = 15; // across all clients: defeats rotating client ids
const BASE_LOCKOUT_MS = 30_000; // first lockout, doubles each time, capped below
const MAX_LOCKOUT_MS = 15 * 60_000;
const MAX_TRACKED_CLIENTS = 256;

/**
 * Stores keypad users with scrypt-hashed PINs in Homey app settings and
 * enforces lockouts after repeated wrong PINs, both per client and globally.
 *
 * Stored shape (settings 'users'):
 *   [{ id, name, enabled, canArm, canDisarm, salt, hash }]
 * PINs are never stored or returned in plain text. Hashing is asynchronous
 * and serialised so a flood of attempts cannot block the event loop (and
 * with it the alarm timers).
 */
class PinStore {

  constructor({ settings, log = () => {} }) {
    this._settings = settings;
    this._log = log;
    this._failures = new Map(); // clientKey -> { count, lockedUntil, lockouts }
    this._global = { count: 0, lockedUntil: 0, lockouts: 0 };
    this._queue = Promise.resolve();
  }

  _load() {
    const users = this._settings.get(SETTINGS_KEY);
    return Array.isArray(users) ? users : [];
  }

  _save(users) {
    this._settings.set(SETTINGS_KEY, users);
  }

  /** Public listing, safe to send to the settings page. */
  list() {
    return this._load().map(u => ({
      id: u.id,
      name: u.name,
      enabled: u.enabled !== false,
      canArm: u.canArm !== false,
      canDisarm: u.canDisarm !== false,
      hasPin: Boolean(u.hash),
    }));
  }

  hasUsers() {
    return this._load().length > 0;
  }

  /**
   * Replace the user list. Entries may carry a plain `pin` which is hashed
   * here; entries without `pin` keep their existing hash. Rejects a new PIN
   * that collides with another user's PIN, or that would be ambiguous with a
   * PIN plus the panic suffix (so a duress code can never credit the wrong user).
   * @param {Array} list
   * @param {{ panicSuffix?: string }} [opts]
   */
  async replace(list = [], { panicSuffix = '' } = {}) {
    if (!Array.isArray(list)) throw new Error('users must be an array');
    const existing = new Map(this._load().map(u => [u.id, u]));
    const out = [];
    const newPins = new Map(); // plain pin -> name, for the entries that set one

    for (const u of list) {
      if (!u || typeof u.name !== 'string' || !u.name.trim()) continue;
      const id = typeof u.id === 'string' && u.id ? u.id : crypto.randomUUID();
      const prev = existing.get(id);
      const entry = {
        id,
        name: u.name.trim().slice(0, 64),
        enabled: u.enabled !== false,
        canArm: u.canArm !== false,
        canDisarm: u.canDisarm !== false,
        salt: prev ? prev.salt : null,
        hash: prev ? prev.hash : null,
      };

      if (typeof u.pin === 'string' && u.pin.length > 0) {
        if (!/^\d{4,8}$/.test(u.pin)) throw new Error(`PIN for ${entry.name} must be 4 to 8 digits`);
        if (newPins.has(u.pin)) throw new Error('Two users cannot share the same PIN');
        newPins.set(u.pin, entry.name);
        entry.salt = crypto.randomBytes(16).toString('hex');
        entry.hash = await hashPin(u.pin, entry.salt);
      }

      if (!entry.hash) throw new Error(`User ${entry.name} has no PIN`);
      out.push(entry);
    }

    // Collision checks against the kept (hashed) PINs of the other users.
    for (const [pin, name] of newPins) {
      const variants = new Set([pin]);
      if (panicSuffix) {
        variants.add(pin + panicSuffix);
        if (pin.endsWith(panicSuffix) && pin.length - panicSuffix.length >= 4) variants.add(pin.slice(0, -panicSuffix.length));
      }
      for (const other of out) {
        if (other.name === name && newPins.get(pin) === other.name) continue;
        for (const v of variants) {
          if (await matchesUser(other, v)) {
            throw new Error(`PIN for ${name} is the same as, or too similar to, the PIN of ${other.name}`);
          }
        }
      }
      // also against other *new* pins with the suffix
      for (const [otherPin, otherName] of newPins) {
        if (otherName === name) continue;
        if (panicSuffix && (otherPin === pin + panicSuffix || pin === otherPin + panicSuffix)) {
          throw new Error(`PINs of ${name} and ${otherName} are ambiguous with the panic digits`);
        }
      }
    }

    this._save(out);
    return this.list();
  }

  /**
   * Verify a PIN for a client (widget instance, keypad, ...). Serialised.
   *
   * Panic / duress code: when `panicSuffix` is set, a user can enter their
   * normal PIN followed by that suffix. The result is identical to a normal
   * success (so nothing on screen gives it away) except for `panic: true`.
   *
   * @returns {Promise<{ ok: true, user, panic: boolean } | { ok: false, reason: 'locked'|'invalid'|'no_users', retryAfter?: number, attemptsLeft?: number }>}
   */
  verify(pin, clientKey = 'global', opts = {}) {
    const run = () => this._verify(pin, clientKey, opts);
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  async _verify(pin, clientKey, { panicSuffix = '' } = {}) {
    const now = Date.now();
    const state = this._failures.get(clientKey) || { count: 0, lockedUntil: 0, lockouts: 0 };

    const lockedUntil = Math.max(state.lockedUntil, this._global.lockedUntil);
    if (lockedUntil > now) {
      return { ok: false, reason: 'locked', retryAfter: Math.ceil((lockedUntil - now) / 1000) };
    }

    const users = this._load();
    if (users.length === 0) return { ok: false, reason: 'no_users' };

    let match = await this._match(users, pin);
    let panic = false;
    if (!match && panicSuffix && typeof pin === 'string' && pin.length > panicSuffix.length && pin.endsWith(panicSuffix)) {
      match = await this._match(users, pin.slice(0, -panicSuffix.length));
      panic = Boolean(match);
    }

    // A disabled user's PIN is treated exactly like a wrong PIN, so the
    // response does not reveal that the code is real.
    if (match && match.enabled === false) {
      this._log(`PIN of disabled user ${match.name} used by ${clientKey}`);
      match = null;
    }

    if (!match) {
      return this._recordFailure(clientKey, state, now);
    }

    // success resets the counters but keeps some escalation memory
    this._failures.set(clientKey, { count: 0, lockedUntil: 0, lockouts: Math.max(0, state.lockouts - 1) });
    this._global.count = 0;

    return {
      ok: true,
      panic,
      user: {
        id: match.id,
        name: match.name,
        canArm: match.canArm !== false,
        canDisarm: match.canDisarm !== false,
      },
    };
  }

  _recordFailure(clientKey, state, now) {
    state.count += 1;
    this._global.count += 1;

    let lock = 0;
    if (state.count >= MAX_FAILURES) {
      state.count = 0;
      state.lockouts += 1;
      lock = Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * (2 ** (state.lockouts - 1)));
      state.lockedUntil = now + lock;
      this._log(`PIN lockout for ${clientKey} for ${lock / 1000}s`);
    }
    if (this._global.count >= GLOBAL_MAX_FAILURES) {
      this._global.count = 0;
      this._global.lockouts += 1;
      const glock = Math.min(MAX_LOCKOUT_MS, 2 * BASE_LOCKOUT_MS * (2 ** (this._global.lockouts - 1)));
      this._global.lockedUntil = now + glock;
      lock = Math.max(lock, glock);
      this._log(`Global PIN lockout for ${glock / 1000}s`);
    }

    this._failures.set(clientKey, state);
    if (this._failures.size > MAX_TRACKED_CLIENTS) {
      this._failures.delete(this._failures.keys().next().value); // oldest entry
    }

    if (lock > 0) return { ok: false, reason: 'locked', retryAfter: Math.ceil(lock / 1000) };
    return { ok: false, reason: 'invalid', attemptsLeft: MAX_FAILURES - state.count };
  }

  /** Match a plain PIN against all users; always checks every user. */
  async _match(users, pin) {
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) return null;
    let match = null;
    for (const u of users) {
      if (await matchesUser(u, pin)) match = u;
    }
    return match;
  }

}

async function hashPin(pin, salt) {
  const key = await scrypt(String(pin), Buffer.from(salt, 'hex'), SCRYPT_KEYLEN, SCRYPT_OPTS);
  return key.toString('hex');
}

async function matchesUser(user, pin) {
  if (!user.hash || !user.salt) return false;
  const a = Buffer.from(await hashPin(pin, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = PinStore;
