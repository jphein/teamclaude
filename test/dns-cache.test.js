import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCachedLookup } from '../src/dns-cache.js';

// A resolver stub whose callbacks we fire by hand, so we can observe caching and
// in-flight coalescing deterministically without touching real DNS.
function deferredResolver() {
  const calls = [];
  return { fn: (host, cb) => calls.push({ host, cb }), calls };
}

test('cachedLookup returns the first IP in dns.lookup default form', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn });
  let addr, fam;
  lookup('api.x', {}, (e, a, f) => { addr = a; fam = f; });
  calls[0].cb(null, ['1.2.3.4', '5.6.7.8']);
  assert.equal(addr, '1.2.3.4');
  assert.equal(fam, 4);
});

test('cachedLookup honors opts.all (array form)', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn });
  let out;
  lookup('api.x', { all: true }, (e, a) => { out = a; });
  calls[0].cb(null, ['1.2.3.4', '5.6.7.8']);
  assert.deepEqual(out, [{ address: '1.2.3.4', family: 4 }, { address: '5.6.7.8', family: 4 }]);
});

test('cachedLookup accepts an omitted opts arg (cb as 2nd arg)', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn });
  let addr;
  lookup('api.x', (e, a) => { addr = a; });
  calls[0].cb(null, ['9.9.9.9']);
  assert.equal(addr, '9.9.9.9');
});

test('cachedLookup serves a cached result without re-resolving', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn });
  lookup('h', {}, () => {});
  calls[0].cb(null, ['1.1.1.1']);
  let second;
  lookup('h', {}, (e, a) => { second = a; });
  assert.equal(calls.length, 1, 'the second lookup must be served from cache');
  assert.equal(second, '1.1.1.1');
});

test('cachedLookup coalesces concurrent misses into ONE resolve4 (anti-flood)', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn });
  const got = [];
  lookup('api.x', {}, (e, a) => got.push(a));
  lookup('api.x', {}, (e, a) => got.push(a));
  lookup('api.x', {}, (e, a) => got.push(a));
  assert.equal(calls.length, 1, 'a burst of concurrent lookups must fire only one underlying query');
  calls[0].cb(null, ['4.4.4.4']);
  assert.deepEqual(got, ['4.4.4.4', '4.4.4.4', '4.4.4.4'], 'all waiters get the answer');
});

test('cachedLookup serves the stale IP when a re-resolution fails', () => {
  const { fn, calls } = deferredResolver();
  let t = 1000;
  const lookup = makeCachedLookup({ resolve4: fn, ttlMs: 100, now: () => t });
  lookup('h', {}, () => {});
  calls[0].cb(null, ['5.5.5.5']);   // cached at t=1000, expires at t=1100
  t = 5000;                          // now stale
  let err, got;
  lookup('h', {}, (e, a) => { err = e; got = a; });
  assert.equal(calls.length, 2, 'a stale entry triggers a re-resolve');
  calls[1].cb(new Error('SERVFAIL')); // ...which fails
  assert.equal(err, null, 'a failed re-resolve must NOT surface an error when we have a stale IP');
  assert.equal(got, '5.5.5.5');
});

test('cachedLookup propagates the error when resolution fails with no cache', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn });
  let err;
  lookup('h', {}, (e) => { err = e; });
  calls[0].cb(new Error('ENOTFOUND'));
  assert.ok(err instanceof Error, 'a cold-cache failure must reach the caller');
});
