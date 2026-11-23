import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LRUTTLCache } from '../src/index.js';

// A controllable clock. Tests advance it explicitly so nothing depends on
// wall-clock time or sleeps.
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

test('set and get round-trip a value', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
});

test('get on a missing key returns undefined', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  assert.equal(cache.get('nope'), undefined);
});

test('entries expire once their TTL elapses', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  cache.set('a', 1, 100);
  clock.advance(99);
  assert.equal(cache.get('a'), 1);
  clock.advance(1);
  assert.equal(cache.get('a'), undefined);
});

test('default TTL applies when set does not specify one', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ ttlMs: 50, now: clock.now });
  cache.set('a', 1);
  clock.advance(50);
  assert.equal(cache.has('a'), false);
});

test('per-entry TTL overrides the default', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ ttlMs: 10, now: clock.now });
  cache.set('long', 1, 1000);
  clock.advance(500);
  assert.equal(cache.get('long'), 1);
});

test('LRU eviction drops the least-recently-used entry', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ maxSize: 2, now: clock.now });
  cache.set('a', 1);
  cache.set('b', 2);
  // Touch 'a' so 'b' becomes the LRU entry.
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('overwriting a key refreshes its recency', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ maxSize: 2, now: clock.now });
  cache.set('a', 1);
  cache.set('b', 2);
  // Re-set 'a' with a new value; it should now be the most recent.
  cache.set('a', 10);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 10);
  assert.equal(cache.get('c'), 3);
});

test('expired entries are pruned before capacity eviction', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ maxSize: 2, now: clock.now });
  cache.set('a', 1, 10);
  cache.set('b', 2);
  clock.advance(10);
  // 'a' is expired; adding 'c' should evict 'a' (expired) rather than 'b'.
  cache.set('c', 3);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});

test('has does not refresh recency', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ maxSize: 2, now: clock.now });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.has('a'), true);
  cache.set('c', 3);
  // 'a' was only checked with has, so it should still be the LRU entry.
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});

test('delete reports whether a live entry was removed', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  cache.set('a', 1, 10);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  cache.set('b', 2, 10);
  clock.advance(10);
  // Expired entry: delete removes it but reports false.
  assert.equal(cache.delete('b'), false);
});

test('clear removes all entries', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('a'), undefined);
});

test('size excludes expired entries and prunes them', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  cache.set('a', 1, 10);
  cache.set('b', 2, 1000);
  clock.advance(10);
  assert.equal(cache.size, 1);
  assert.equal(cache.has('a'), false);
});

test('keys and values iterate in LRU order', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  // Touch 'a' so order becomes b, c, a.
  cache.get('a');
  assert.deepEqual([...cache.keys()], ['b', 'c', 'a']);
  assert.deepEqual([...cache.values()], [2, 3, 1]);
  assert.deepEqual([...cache.entries()], [['b', 2], ['c', 3], ['a', 1]]);
});

test('prune removes expired entries without touching live ones', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  cache.set('a', 1, 10);
  cache.set('b', 2, 1000);
  clock.advance(10);
  cache.prune();
  assert.equal(cache.has('b'), true);
  assert.equal(cache.get('a'), undefined);
});

test('maxSize 0 makes set a no-op', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ maxSize: 0, now: clock.now });
  cache.set('a', 1);
  assert.equal(cache.size, 0);
  assert.equal(cache.get('a'), undefined);
});

test('ttlMs 0 expires immediately', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  cache.set('a', 1, 0);
  assert.equal(cache.get('a'), undefined);
});

test('Infinity TTL never expires', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  cache.set('a', 1, Infinity);
  clock.advance(1e9);
  assert.equal(cache.get('a'), 1);
});

test('constructor rejects invalid maxSize', () => {
  assert.throws(() => new LRUTTLCache({ maxSize: -1 }), RangeError);
  assert.throws(() => new LRUTTLCache({ maxSize: 1.5 }), RangeError);
});

test('constructor rejects invalid ttlMs', () => {
  assert.throws(() => new LRUTTLCache({ ttlMs: -1 }), RangeError);
  assert.throws(() => new LRUTTLCache({ ttlMs: NaN }), RangeError);
});

test('set rejects invalid per-entry ttlMs', () => {
  const clock = makeClock();
  const cache = new LRUTTLCache({ now: clock.now });
  assert.throws(() => cache.set('a', 1, -5), RangeError);
  assert.throws(() => cache.set('a', 1, NaN), RangeError);
});
