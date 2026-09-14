import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCachedLookup } from '../src/dns-cache.js';

// A resolver stub whose callbacks we fire by hand, so we can observe caching and
// in-flight coalescing deterministically without touching real DNS.
function deferredResolver() {
  const calls = [];
  return { fn: (host, cb) => calls.push({ host, cb }), calls };
}

// The AAAA side of a lookup, answering "no such record" synchronously, so the
// existing A-record tests keep their one-callback shape.
const noV6 = (host, cb) => cb(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));

test('cachedLookup returns the first IP in dns.lookup default form', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6 });
  let addr, fam;
  lookup('api.x', {}, (e, a, f) => { addr = a; fam = f; });
  calls[0].cb(null, ['1.2.3.4', '5.6.7.8']);
  assert.equal(addr, '1.2.3.4');
  assert.equal(fam, 4);
});

test('cachedLookup honors opts.all (array form)', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6 });
  let out;
  lookup('api.x', { all: true }, (e, a) => { out = a; });
  calls[0].cb(null, ['1.2.3.4', '5.6.7.8']);
  assert.deepEqual(out, [{ address: '1.2.3.4', family: 4 }, { address: '5.6.7.8', family: 4 }]);
});

test('cachedLookup accepts an omitted opts arg (cb as 2nd arg)', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6 });
  let addr;
  lookup('api.x', (e, a) => { addr = a; });
  calls[0].cb(null, ['9.9.9.9']);
  assert.equal(addr, '9.9.9.9');
});

test('cachedLookup serves a cached result without re-resolving', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6 });
  lookup('h', {}, () => {});
  calls[0].cb(null, ['1.1.1.1']);
  let second;
  lookup('h', {}, (e, a) => { second = a; });
  assert.equal(calls.length, 1, 'the second lookup must be served from cache');
  assert.equal(second, '1.1.1.1');
});

test('cachedLookup coalesces concurrent misses into ONE resolve4 (anti-flood)', () => {
  const { fn, calls } = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6 });
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
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6, ttlMs: 100, now: () => t });
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
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6, fallbackLookup: (h, o, cb) => cb(new Error('ENOTFOUND')) });
  let err;
  lookup('h', {}, (e) => { err = e; });
  calls[0].cb(new Error('ENOTFOUND'));
  assert.ok(err instanceof Error, 'a cold-cache failure must reach the caller');
});

// ── getaddrinfo fallback (new since the v1.1.12 sync) ─────────
// MITM tunnels dial arbitrary hosts, including LAN names that only resolve
// through the search-domain list or /etc/hosts — resolve4 alone would break
// them. A cold-cache resolve4 miss now falls back to the real dns.lookup;
// serve-stale still wins over the fallback for previously-resolved hosts.

function deferredFallback() {
  const calls = [];
  return { fn: (host, opts, cb) => calls.push({ host, opts, cb }), calls };
}

test('a cold-cache resolve4 miss falls back to dns.lookup and caches its answer', () => {
  const { fn, calls } = deferredResolver();
  const fb = deferredFallback();
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6, fallbackLookup: fb.fn });
  let err, addr;
  lookup('familiar', {}, (e, a) => { err = e; addr = a; });
  calls[0].cb(new Error('ENOTFOUND'));
  assert.equal(fb.calls.length, 1, 'resolve4 miss must consult getaddrinfo');
  fb.calls[0].cb(null, [{ address: '10.0.6.20', family: 4 }]);
  assert.equal(err, null);
  assert.equal(addr, '10.0.6.20');

  // …and the fallback answer is cached: no second query of either kind.
  let second;
  lookup('familiar', {}, (e, a) => { second = a; });
  assert.equal(calls.length, 1);
  assert.equal(fb.calls.length, 1);
  assert.equal(second, '10.0.6.20');
});

test('the error propagates only when resolve4, stale cache, AND fallback all miss', () => {
  const { fn, calls } = deferredResolver();
  const fb = deferredFallback();
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6, fallbackLookup: fb.fn });
  let err;
  lookup('nope.invalid', {}, (e) => { err = e; });
  calls[0].cb(new Error('ENODATA'));
  fb.calls[0].cb(new Error('ENOTFOUND'));
  assert.ok(err instanceof Error, 'a total miss must reach the caller');
});

test('a stale entry beats the fallback: no getaddrinfo call for a known host', () => {
  const { fn, calls } = deferredResolver();
  const fb = deferredFallback();
  let t = 1000;
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6, fallbackLookup: fb.fn, ttlMs: 100, now: () => t });
  lookup('api.x', {}, () => {});
  calls[0].cb(null, ['5.5.5.5']);
  t = 5000; // stale
  let got;
  lookup('api.x', {}, (e, a) => { got = a; });
  calls[1].cb(new Error('SERVFAIL'));
  assert.equal(got, '5.5.5.5');
  assert.equal(fb.calls.length, 0, 'serve-stale must not fall through to getaddrinfo');
});

test('coalesced waiters all get the fallback answer', () => {
  const { fn, calls } = deferredResolver();
  const fb = deferredFallback();
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6, fallbackLookup: fb.fn });
  const got = [];
  lookup('lanhost', {}, (e, a) => got.push(a));
  lookup('lanhost', { all: true }, (e, a) => got.push(a));
  assert.equal(calls.length, 1);
  calls[0].cb(new Error('ENOTFOUND'));
  fb.calls[0].cb(null, [{ address: '10.0.6.7', family: 4 }]);
  assert.equal(got[0], '10.0.6.7');
  assert.deepEqual(got[1], [{ address: '10.0.6.7', family: 4 }]);
});

test('a dual-stack fallback answer keeps every address with its own family', () => {
  // CI's `localhost` is 127.0.0.1 AND ::1. Forcing family 4 on the fallback hid
  // the ::1 from a happy-eyeballs dial and from the "every address refused"
  // log line (connect-error-message tests, skipped on IPv4-only hosts).
  const { fn, calls } = deferredResolver();
  const fb = deferredFallback();
  const lookup = makeCachedLookup({ resolve4: fn, resolve6: noV6, fallbackLookup: fb.fn });
  let all, first, fam;
  lookup('localhost', { all: true }, (e, a) => { all = a; });
  lookup('localhost', {}, (e, a, f) => { first = a; fam = f; });
  calls[0].cb(new Error('ENOTFOUND'));
  fb.calls[0].cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]);
  assert.deepEqual(all, [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]);
  assert.equal(first, '127.0.0.1');
  assert.equal(fam, 4);

  // A string-form answer (older lookup shims) is classified by shape.
  const { fn: fn2, calls: calls2 } = deferredResolver();
  const fb2 = deferredFallback();
  const lookup2 = makeCachedLookup({ resolve4: fn2, resolve6: noV6, fallbackLookup: fb2.fn });
  let out;
  lookup2('v6only', { all: true }, (e, a) => { out = a; });
  calls2[0].cb(new Error('ENODATA'));
  fb2.calls[0].cb(null, ['fd00::7']);
  assert.deepEqual(out, [{ address: 'fd00::7', family: 6 }]);
});

test('A and AAAA are queried together and merged, IPv4 first', () => {
  // CI's c-ares answers `localhost` A itself, so the getaddrinfo fallback never
  // ran and ::1 was never seen. Both records are asked for on every miss.
  const a = deferredResolver();
  const aaaa = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: a.fn, resolve6: aaaa.fn });
  let all;
  lookup('localhost', { all: true }, (e, x) => { all = x; });
  assert.equal(a.calls.length, 1); assert.equal(aaaa.calls.length, 1);
  aaaa.calls[0].cb(null, ['::1']);            // AAAA may answer first…
  assert.equal(all, undefined, 'settles only once both records have answered');
  a.calls[0].cb(null, ['127.0.0.1']);
  assert.deepEqual(all, [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]);

  // Cached as one entry: a repeat costs no query of either kind.
  let again;
  lookup('localhost', {}, (e, x, f) => { again = [x, f]; });
  assert.equal(a.calls.length, 1); assert.equal(aaaa.calls.length, 1);
  assert.deepEqual(again, ['127.0.0.1', 4]);
});

test('an AAAA-only host resolves through the AAAA answer alone', () => {
  const a = deferredResolver();
  const aaaa = deferredResolver();
  const lookup = makeCachedLookup({ resolve4: a.fn, resolve6: aaaa.fn });
  let addr, fam;
  lookup('v6.x', {}, (e, x, f) => { addr = x; fam = f; });
  a.calls[0].cb(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
  aaaa.calls[0].cb(null, ['fd00::9']);
  assert.equal(addr, 'fd00::9'); assert.equal(fam, 6);
});
