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

// Cache entries are [{ address, family }]: A records from c-ares are family 4;
// the getaddrinfo fallback may hand back both families (a dual-stack
// `localhost`, a LAN name with an AAAA), and a dial that asks for `all` must
// see every address with its real family — happy-eyeballs tries each and the
// operator's error line names each one that refused.
/** @typedef {{ address: string, family: number }} Entry */
/** @typedef {{ all?: boolean, family?: number } | undefined} LookupOpts */
/** @typedef {(err: Error | null, address?: any, family?: number) => void} LookupCb */

/** @param {LookupOpts} opts @param {LookupCb} cb @param {Entry[]} entries */
function deliver(opts, cb, entries) {
  if (opts?.all) cb(null, entries.map(({ address, family }) => ({ address, family })));
  else cb(null, entries[0].address, entries[0].family);
}

/** @param {string} address @returns {number} */
function familyOf(address) {
  return address.includes(':') ? 6 : 4;
}

export function makeCachedLookup({
  resolve4 = dns.resolve4,
  resolve6 = dns.resolve6,
  fallbackLookup = dns.lookup,
  ttlMs = DNS_TTL,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, { ips: Entry[], expires: number }>} */
  const cache = new Map();    // hostname → { ips, expires }
  /** @type {Map<string, Array<[LookupOpts, LookupCb]>>} */
  const inflight = new Map(); // hostname → [ [opts, cb], ... ] waiters sharing one query

  // Typed loosely on purpose: Node's Agent/net `lookup` option types differ
  // by version, and this function is handed to all of them.
  /** @param {string} hostname @param {any} optsOrCb @param {any} [maybeCb] */
  function cachedLookup(hostname, optsOrCb, maybeCb) {
    /** @type {LookupOpts} */
    const opts = typeof optsOrCb === 'function' ? {} : (optsOrCb || {});
    /** @type {LookupCb} */
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    if (typeof cb !== 'function') throw new TypeError('cachedLookup: callback required');

    const entry = cache.get(hostname);
    if (entry && entry.expires > now()) return deliver(opts, cb, entry.ips);

    const waiters = inflight.get(hostname);
    if (waiters) { waiters.push([opts, cb]); return; } // join the in-flight query

    /** @type {Array<[LookupOpts, LookupCb]>} */
    const queue = [[opts, cb]];
    inflight.set(hostname, queue);

    /** @param {Entry[]} entries */
    const settle = (entries) => {
      inflight.delete(hostname);
      cache.set(hostname, { ips: entries, expires: now() + ttlMs });
      for (const [o, c] of queue) deliver(o, c, entries);
    };
    /** @param {Error} err */
    const failAll = (err) => {
      inflight.delete(hostname);
      for (const [, c] of queue) c(err);
    };

    // A and AAAA together, one query each, still coalesced per host and
    // cached as one entry. IPv4 stays first so the dial order is unchanged
    // for hosts that have both; a host with only one family (or a resolver
    // that answers ENODATA for the other) is simply that family.
    let pending = 2;
    /** @type {string[]} */ let v4 = [];
    /** @type {string[]} */ let v6 = [];
    /** @type {Error | null} */ let err4 = null;
    /** @type {Error | null} */ let err6 = null;
    const onBoth = () => {
      if (--pending > 0) return;
      const entries = [
        ...v4.map((address) => ({ address, family: 4 })),
        ...v6.map((address) => ({ address, family: 6 })),
      ];
      if (entries.length > 0) return settle(entries);
      const err = err4 || err6 || new Error(`no address for ${hostname}`);

      // Serve stale rather than fail if we ever resolved this host: the
      // last-known-good IP outlives any resolver blip.
      const stale = cache.get(hostname);
      if (stale) {
        inflight.delete(hostname);
        for (const [o, c] of queue) deliver(o, c, stale.ips);
        return;
      }

      // Cold cache and no A record via c-ares: fall back to getaddrinfo, which
      // still honors /etc/hosts and the search-domain list (LAN names). Both
      // families: restricting to IPv4 here hid a dual-stack host's ::1 from
      // the dial and from the "every address refused" log line.
      fallbackLookup(hostname, { all: true }, (fbErr, addrs) => {
        if (fbErr || !addrs || addrs.length === 0) {
          return failAll(fbErr || err);
        }
        settle(addrs.map((a) => (typeof a === 'string'
          ? { address: a, family: familyOf(a) }
          : { address: a.address, family: a.family || familyOf(a.address) })));
      });
    };
    resolve4(hostname, (e, ips) => { err4 = e; v4 = (!e && ips) ? [...ips] : []; onBoth(); });
    resolve6(hostname, (e, ips) => { err6 = e; v6 = (!e && ips) ? [...ips] : []; onBoth(); });
  }
  return cachedLookup;
}

// The process-wide shared instance. Import THIS everywhere so one host's answer
// is cached once and reused across the MITM path, upstream fetch, and OAuth.
export const cachedLookup = makeCachedLookup();
