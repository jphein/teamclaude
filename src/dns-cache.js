// Shared in-process DNS cache, exposed as a drop-in `dns.lookup`-compatible
// function so it can be handed to net/tls (`{ lookup }`) and http(s) agents.
//
// It resolves via dns.resolve4 (c-ares), which bypasses getaddrinfo, nsswitch,
// and — crucially — the search-domain list. A long-running process doing
// high-volume lookups through getaddrinfo can flood the stub resolver and trip
// search-domain fallback (api.anthropic.com.lan → NXDOMAIN → a hard ENOTFOUND).
// On top of that it (a) caches answers, (b) coalesces concurrent misses for
// the same host into a single query so a burst (e.g. all accounts refreshing
// tokens at once on a quota reset) can't fan out into a resolver flood, and
// (c) serves the last-known-good IP when a re-resolution fails, so a resolver
// blip doesn't take every request down with it.
//
// Re-added 2026-08-08: dropped in the v1.1.12 sync on the theory that
// upstream's pooled keep-alive fetch lowers the lookup rate enough — the
// ENOTFOUND flood recurred the first night (hourly resolver bursts, 217
// hard failures). New since the original: a cold-cache resolve4 miss falls
// back to the real dns.lookup (getaddrinfo), because MITM tunnels dial
// arbitrary hosts including LAN names that only resolve via the search-domain
// list or /etc/hosts. Serve-stale still wins over the fallback.

import dns from 'node:dns';

const DNS_TTL = 300_000; // 300s — well above the ~32s record TTL, for resilience

function deliver(opts, cb, ips) {
  if (opts?.all) cb(null, ips.map((address) => ({ address, family: 4 })));
  else cb(null, ips[0], 4);
}

export function makeCachedLookup({
  resolve4 = dns.resolve4,
  fallbackLookup = dns.lookup,
  ttlMs = DNS_TTL,
  now = () => Date.now(),
} = {}) {
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

    const settle = (ips) => {
      inflight.delete(hostname);
      cache.set(hostname, { ips, expires: now() + ttlMs });
      for (const [o, c] of queue) deliver(o, c, ips);
    };
    const failAll = (err) => {
      inflight.delete(hostname);
      for (const [, c] of queue) c(err);
    };

    resolve4(hostname, (err, ips) => {
      if (!err && ips && ips.length > 0) return settle(ips);

      // Serve stale rather than fail if we ever resolved this host: the
      // last-known-good IP outlives any resolver blip.
      const stale = cache.get(hostname);
      if (stale) {
        inflight.delete(hostname);
        for (const [o, c] of queue) deliver(o, c, stale.ips);
        return;
      }

      // Cold cache and no A record via c-ares: fall back to getaddrinfo, which
      // still honors /etc/hosts and the search-domain list (LAN names).
      fallbackLookup(hostname, { all: true, family: 4 }, (fbErr, addrs) => {
        if (fbErr || !addrs || addrs.length === 0) {
          return failAll(err || fbErr || new Error(`no A record for ${hostname}`));
        }
        settle(addrs.map((a) => (typeof a === 'string' ? a : a.address)));
      });
    });
  };
}

// The process-wide shared instance. Import THIS everywhere so one host's answer
// is cached once and reused across the MITM path, upstream fetch, and OAuth.
export const cachedLookup = makeCachedLookup();
