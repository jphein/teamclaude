// Shared in-process DNS cache, exposed as a drop-in `dns.lookup`-compatible
// function so it can be handed to net/tls (`{ lookup }`) and https.request.
//
// It resolves via dns.resolve4 (c-ares), which bypasses getaddrinfo, nsswitch,
// and — crucially — the search-domain list. A long-running process doing
// high-volume lookups through getaddrinfo can flood the stub resolver and trip
// search-domain fallback (api.anthropic.com.lan → NXDOMAIN → a hard ENOTFOUND).
// On top of that it (a) caches answers and (b) coalesces concurrent misses for
// the same host into a single query, so a burst (e.g. all accounts refreshing
// tokens at once on a quota reset) can't fan out into a resolver flood.

import dns from 'node:dns';

const DNS_TTL = 300_000; // 300s — well above the ~32s record TTL, for resilience

function deliver(opts, cb, ips) {
  if (opts?.all) cb(null, ips.map((address) => ({ address, family: 4 })));
  else cb(null, ips[0], 4);
}

export function makeCachedLookup({ resolve4 = dns.resolve4, ttlMs = DNS_TTL, now = () => Date.now() } = {}) {
  const cache = new Map();    // hostname → { ips, expires }
  const inflight = new Map(); // hostname → [ [opts, cb], ... ] waiters sharing one query

  return function cachedLookup(hostname, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }

    const entry = cache.get(hostname);
    if (entry && entry.expires > now()) return deliver(opts, cb, entry.ips);

    const waiters = inflight.get(hostname);
    if (waiters) { waiters.push([opts, cb]); return; } // join the in-flight query

    const queue = [[opts, cb]];
    inflight.set(hostname, queue);
    resolve4(hostname, (err, ips) => {
      inflight.delete(hostname);
      if (err || !ips || ips.length === 0) {
        const stale = cache.get(hostname); // serve stale rather than fail if we ever resolved it
        for (const [o, c] of queue) stale ? deliver(o, c, stale.ips) : c(err || new Error(`no A record for ${hostname}`));
        return;
      }
      cache.set(hostname, { ips, expires: now() + ttlMs });
      for (const [o, c] of queue) deliver(o, c, ips);
    });
  };
}

// The process-wide shared instance. Import THIS everywhere so one host's answer
// is cached once and reused across the MITM path, upstream fetch, and OAuth.
export const cachedLookup = makeCachedLookup();
