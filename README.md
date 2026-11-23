# tiny-lru-ttl-cache

A small in-memory cache that evicts entries when they expire and, separately, when the cache exceeds a maximum size — dropping the least-recently-used entry first.

```js
import { LRUTTLCache } from 'tiny-lru-ttl-cache';

const cache = new LRUTTLCache({ maxSize: 100, ttlMs: 30_000 });

cache.set('user:1', { name: 'Ada' });
cache.set('user:2', { name: 'Grace' }, 5_000); // per-entry TTL

cache.get('user:1'); // { name: 'Ada' }
cache.has('user:2'); // true
cache.delete('user:1'); // true
cache.size; // 1
```

## Why this exists

Most small caches pick one eviction rule. A pure LRU cache will happily hold a stale entry forever if nothing else is competing for space; a pure TTL cache will grow without bound if new keys keep arriving faster than old ones expire. This library applies both: expired entries are pruned first, and only then does capacity pressure evict the LRU entry. The trade-off is that there is no background timer — pruning happens lazily on `set`, `get`, `has`, `size`, `prune`, and the iterators. That keeps the library dependency-free and predictable, at the cost of memory being reclaimed slightly later than a timer-based cache would. For a cache of a few thousand entries this is the right trade.

## API

### `new LRUTTLCache(options?)`

- `options.maxSize` — maximum number of live entries. Defaults to `Infinity`. Must be a non-negative integer or `Infinity`.
- `options.ttlMs` — default TTL in milliseconds. Defaults to `Infinity`. Must be a non-negative number or `Infinity`.
- `options.now` — a function returning the current time in milliseconds. Defaults to `Date.now`. Inject a fake clock in tests.

### Methods

- `set(key, value, ttlMs?)` — store a value. `ttlMs` overrides the default TTL for this entry only. Returns the cache.
- `get(key)` — return the value, or `undefined` if missing or expired. Refreshes recency on a hit.
- `has(key)` — return `true` if a live entry exists. **Does not refresh recency.**
- `delete(key)` — remove a key. Returns `true` if a live entry was removed, `false` if the key was missing or already expired.
- `clear()` — remove everything.
- `prune()` — remove expired entries now.
- `keys()`, `values()`, `entries()` — iterate live entries in LRU order (least-recently-used first). Expired entries are pruned before iteration starts.
- `size` — number of live entries. Reading it prunes expired entries.

## The awkward edge

`has` does not refresh recency. This is deliberate: it lets you check existence without perturbing the eviction order, which matters when you are scanning a cache. The cost is that `has` followed by `set` on a different key can evict the key you just checked. If you want the recency bump, use `get`.
