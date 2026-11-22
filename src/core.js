// Core implementation for tiny-lru-ttl-cache.
//
// Design choice: a Map is used for storage because it preserves insertion order,
// which makes LRU eviction O(1) with a delete+set pair. A doubly linked list would
// be slightly faster in theory but would require manual pointer management and
// doesn't buy us anything at this size.
//
// Time is injected as a `now` function so tests are deterministic. The default
// clock is `Date.now`, which is monotonic enough for TTL purposes on any single
// process. If you need true monotonicity across clock adjustments, pass
// `performance.now.bind(performance)`.

/**
 * A cache entry. We keep the expiry timestamp alongside the value so eviction
 * can compare against the injected clock without storing a Date object (which
 * would allocate and would be harder to fake in tests).
 */
class Entry {
  constructor(value, expiresAt) {
    this.value = value;
    this.expiresAt = expiresAt;
  }
}

/**
 * LRU cache with per-entry TTL.
 *
 * Eviction policy: on every `set`/`get`/`has` we first drop entries whose
 * `expiresAt <= now`. Then, if the cache is over capacity, we drop the
 * least-recently-used entry (the first key in the Map's iteration order).
 *
 * The TTL is per-entry, not per-cache: `set(key, value, ttlMs)` sets the
 * expiry for that key only. If `ttlMs` is omitted, the entry uses the default
 * TTL passed to the constructor (or `Infinity` if none was given).
 */
export class LRUTTLCache {
  /**
   * @param {object} [options]
   * @param {number} [options.maxSize=Infinity] Maximum number of live entries.
   *   Must be a positive integer or Infinity. Values <= 0 make every `set` a
   *   no-op, which is a valid but rarely useful configuration.
   * @param {number} [options.ttlMs=Infinity] Default TTL in milliseconds for
   *   entries that don't specify their own. Must be >= 0.
   * @param {() => number} [options.now] Clock function returning milliseconds.
   *   Injected for deterministic tests.
   */
  constructor(options = {}) {
    const { maxSize = Infinity, ttlMs = Infinity, now = Date.now } = options;

    if (maxSize !== Infinity && (!Number.isInteger(maxSize) || maxSize < 0)) {
      throw new RangeError('maxSize must be a non-negative integer or Infinity');
    }
    if (ttlMs !== Infinity && (typeof ttlMs !== 'number' || ttlMs < 0 || Number.isNaN(ttlMs))) {
      throw new RangeError('ttlMs must be a non-negative number or Infinity');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }

    this._maxSize = maxSize;
    this._defaultTtlMs = ttlMs;
    this._now = now;
    this._map = new Map();
  }

  /**
   * Number of live entries. Stale entries are not counted; this method prunes
   * them as a side effect, which is the only way to guarantee the number is
   * accurate without a background timer.
   */
  get size() {
    this._pruneExpired();
    return this._map.size;
  }

  /**
   * Store a value. Returns the cache for chaining.
   *
   * @param {*} key
   * @param {*} value
   * @param {number} [ttlMs] Per-entry TTL in ms. Overrides the default.
   */
  set(key, value, ttlMs) {
    const now = this._now();
    const ttl = ttlMs === undefined ? this._defaultTtlMs : ttlMs;

    if (typeof ttl !== 'number' || ttl < 0 || Number.isNaN(ttl)) {
      throw new RangeError('ttlMs must be a non-negative number or Infinity');
    }

    // If the key already exists, remove it so the subsequent set places it at
    // the most-recently-used end of the Map's iteration order.
    this._map.delete(key);

    if (this._maxSize === 0) {
      return this;
    }

    const expiresAt = ttl === Infinity ? Infinity : now + ttl;
    this._map.set(key, new Entry(value, expiresAt));

    // Drop expired entries before enforcing capacity so a burst of expired
    // entries doesn't force us to evict live ones unnecessarily.
    this._pruneExpired();
    this._evictOverCapacity();

    return this;
  }

  /**
   * Retrieve a value. Returns `undefined` if the key is missing or expired.
   * A successful get refreshes the entry's recency.
   */
  get(key) {
    const entry = this._map.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this._isExpired(entry)) {
      this._map.delete(key);
      return undefined;
    }
    // Refresh recency: delete + re-set moves the key to the end of the Map.
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /**
   * Check whether a live entry exists. Expired entries are removed and report
   * `false`. Unlike `get`, this does NOT refresh recency — a common source of
   * surprise, so it is documented here and in the README.
   */
  has(key) {
    const entry = this._map.get(key);
    if (entry === undefined) {
      return false;
    }
    if (this._isExpired(entry)) {
      this._map.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Remove a key. Returns `true` if a live entry was removed. Expired entries
   * are removed too but report `false`, matching the semantics of `has`.
   */
  delete(key) {
    const entry = this._map.get(key);
    if (entry === undefined) {
      return false;
    }
    this._map.delete(key);
    return !this._isExpired(entry);
  }

  /** Remove every entry. */
  clear() {
    this._map.clear();
  }

  /**
   * Iterate live keys in LRU order (least-recently-used first). Stale entries
   * are pruned before iteration begins, so the iterator never yields an
   * expired key.
   */
  *keys() {
    this._pruneExpired();
    yield* this._map.keys();
  }

  /**
   * Iterate live values in LRU order. Stale entries are pruned first.
   */
  *values() {
    this._pruneExpired();
    for (const entry of this._map.values()) {
      yield entry.value;
    }
  }

  /**
   * Iterate live `[key, value]` pairs in LRU order. Stale entries are pruned
   * first. Values are snapshotted at iteration time; mutating the cache during
   * iteration is undefined behaviour, as with Map.
   */
  *entries() {
    this._pruneExpired();
    for (const [key, entry] of this._map.entries()) {
      yield [key, entry.value];
    }
  }

  /**
   * Remove every expired entry. Exposed because `size` and the iterators call
   * it, and callers may want to force a sweep without changing capacity.
   */
  prune() {
    this._pruneExpired();
  }

  _isExpired(entry) {
    return entry.expiresAt !== Infinity && entry.expiresAt <= this._now();
  }

  _pruneExpired() {
    // Iterate a snapshot of the keys so deleting during iteration is safe on
    // every engine we care about. Map iteration order is insertion order, so
    // this is O(n) in the worst case but typically short-circuits quickly
    // because expired entries cluster near the front.
    for (const [key, entry] of this._map) {
      if (this._isExpired(entry)) {
        this._map.delete(key);
      }
    }
  }

  _evictOverCapacity() {
    if (this._maxSize === Infinity) {
      return;
    }
    while (this._map.size > this._maxSize) {
      // The first key in Map iteration order is the least-recently-used.
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }
}
