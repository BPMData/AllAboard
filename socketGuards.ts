/**
 * Server-side guards for what students can send: per-socket rate limits, element size checks and Teacher PIN
 * hashing. The client already throttles itself (src/lib/drawThrottle.ts); these limits are for a client that
 * doesn't (devtools, a stuck loop) so one tab can't flood a room or crash the process.
 *
 * Runs under `node server.ts` type stripping: no enums, namespaces or parameter properties.
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { MIN_TEACHER_PIN_LENGTH } from './src/lib/teacherPin.ts';

// ---------- Rate limits ----------

/** Token bucket: `rate` tokens a second, holding at most `burst`. A burst lets a laggy Chromebook catch up. */
export interface TokenBucket {
  take(): boolean;
}

export function createTokenBucket(rate: number, burst: number, now: () => number = Date.now): TokenBucket {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * rate);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

export type EventClass = 'draw' | 'pointer' | 'chat' | 'other';

const DRAW_EVENTS = new Set([
  'element-start',
  'element-append-points',
  'element-update',
  'elements-batch-update',
  'elements-batch-add',
  'elements-batch-remove',
  'element-remove',
  'undo',
  'clear-user-drawings',
]);

export function eventClass(event: string): EventClass {
  if (DRAW_EVENTS.has(event)) return 'draw';
  if (event === 'cursor-move' || event === 'laser-pulse') return 'pointer';
  if (event === 'chat-message') return 'chat';
  return 'other';
}

/**
 * Per-socket allowances. Normal use, for comparison: ink is sent every 50 ms (20/s) plus the occasional
 * update/remove; cursors at 10/s; the teacher laser at about 28/s.
 */
export const RATE_LIMITS: Record<EventClass, { rate: number; burst: number }> = {
  draw: { rate: 60, burst: 300 },
  pointer: { rate: 50, burst: 100 },
  chat: { rate: 1, burst: 8 },
  other: { rate: 20, burst: 60 },
};

/** One bucket per event class, for one socket. */
export function createSocketLimiter(now: () => number = Date.now) {
  const buckets = {
    draw: createTokenBucket(RATE_LIMITS.draw.rate, RATE_LIMITS.draw.burst, now),
    pointer: createTokenBucket(RATE_LIMITS.pointer.rate, RATE_LIMITS.pointer.burst, now),
    chat: createTokenBucket(RATE_LIMITS.chat.rate, RATE_LIMITS.chat.burst, now),
    other: createTokenBucket(RATE_LIMITS.other.rate, RATE_LIMITS.other.burst, now),
  };
  return {
    /** True if this event is allowed now. */
    allow(event: string): boolean {
      return buckets[eventClass(event)].take();
    },
  };
}

/** Sliding window of failures per key (here: wrong Teacher PINs per room). */
export function createFailureLimiter(maxFailures: number, windowMs: number, now: () => number = Date.now) {
  const failures = new Map<string, number[]>();
  const recent = (key: string) => (failures.get(key) || []).filter((t) => t > now() - windowMs);
  return {
    isBlocked(key: string): boolean {
      const list = recent(key);
      if (list.length) failures.set(key, list);
      else failures.delete(key);
      return list.length >= maxFailures;
    },
    fail(key: string) {
      const list = recent(key);
      list.push(now());
      failures.set(key, list);
    },
    prune() {
      for (const key of Array.from(failures.keys())) this.isBlocked(key);
    },
  };
}

// ---------- Element size checks ----------

/** Numbers in one stroke's `points` (x, y pairs). ~25k points is minutes of continuous drawing. */
export const MAX_STROKE_NUMBERS = 50_000;
/** Numbers in one `element-append-points` message. The client sends a few dozen every 50 ms. */
export const MAX_APPEND_NUMBERS = 4_000;
/** Elements on one board. A full class period is a few thousand strokes; this is a backstop, not a quota. */
export const MAX_BOARD_ELEMENTS = 10_000;
/** Elements in one `elements-batch-add` / `elements-batch-update` (paste, duplicate, move a selection). */
export const MAX_BATCH_ELEMENTS = 2_000;
export const MAX_TEXT_CHARS = 20_000;
/** Any other single field (color, name, stamp kind…), serialized. */
const MAX_FIELD_CHARS = 2_000;

export function isPointArray(value: unknown, max: number): value is number[] {
  if (!Array.isArray(value) || value.length > max) return false;
  for (let i = 0; i < value.length; i++) {
    const n = value[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  }
  return true;
}

/**
 * True if an element (or a patch to one) is a sane size: points are finite numbers within the stroke cap, text is
 * within MAX_TEXT_CHARS, and no other field is a large blob. Cheap: it never stringifies the points.
 */
export function elementFieldsOk(el: unknown): boolean {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return false;
  for (const [key, value] of Object.entries(el as Record<string, unknown>)) {
    if (key === 'points') {
      if (value !== undefined && !isPointArray(value, MAX_STROKE_NUMBERS)) return false;
    } else if (key === 'text') {
      if (value !== undefined && (typeof value !== 'string' || value.length > MAX_TEXT_CHARS)) return false;
    } else if (typeof value === 'string') {
      if (value.length > MAX_FIELD_CHARS) return false;
    } else if (value !== null && typeof value === 'object') {
      const s = JSON.stringify(value);
      if (s === undefined || s.length > MAX_FIELD_CHARS) return false;
    }
  }
  return true;
}

/** Appends without spreading: `push(...arr)` throws a RangeError (and crashed the server) for very large arrays. */
export function appendAll(target: unknown[], items: readonly unknown[]) {
  for (let i = 0; i < items.length; i++) target.push(items[i]);
}

// ---------- Teacher PIN ----------

/** New PINs must be at least this long. Rooms claimed earlier with 3 characters still verify. */
export const MIN_PIN_LENGTH = MIN_TEACHER_PIN_LENGTH;
export const MAX_PIN_LENGTH = 64;
const HASH_PREFIX = 'scrypt:';
const KEY_LEN = 32;

/** Stored form: `scrypt:<salt hex>:<hash hex>`, with a fresh random salt per room. */
export function isHashedPin(stored: string): boolean {
  return stored.startsWith(HASH_PREFIX);
}

function scryptAsync(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pin, salt, KEY_LEN, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pin, salt);
  return `${HASH_PREFIX}${salt.toString('hex')}:${key.toString('hex')}`;
}

/** Sync version, only for migrating a legacy plain-text PIN once when its room loads. */
export function hashPinSync(pin: string): string {
  const salt = randomBytes(16);
  return `${HASH_PREFIX}${salt.toString('hex')}:${scryptSync(pin, salt, KEY_LEN).toString('hex')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  if (!isHashedPin(stored)) {
    // Legacy plain text (migrated on load, so this is only a fallback).
    const a = Buffer.from(pin);
    const b = Buffer.from(stored);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const [saltHex, hashHex] = stored.slice(HASH_PREFIX.length).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(pin, Buffer.from(saltHex, 'hex'));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
