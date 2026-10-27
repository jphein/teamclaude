// Concurrent blind tunnels (CONNECTs to non-Anthropic hosts, piped untouched)
// per client: how many are open now, and the most that were open at once.
//
// 2026-10-21: a burst of parallel api.osv.dev tunnels exhausted the proxy's
// file descriptors (636 × EMFILE). A per-client cap on these tunnels is the
// fix, but its number has to be measured, not guessed: every lane on familiar
// arrives as ONE client ("familiar"), so a healthy peak is unknown. This
// records it. In memory: a restart starts the counts again.
//
// Measured 2026-10-22 → 10-27: familiar's 24 h peak was 33, 52 and 82 across
// windows of normal work. The cap (proxy.maxTunnelsPerClient, default
// DEFAULT_MAX_TUNNELS_PER_CLIENT) is about 4× the highest — room for a busy
// day, far short of the 4096 descriptors one burst once used up.

const HOUR_MS = 3_600_000;
export const DEFAULT_MAX_TUNNELS_PER_CLIENT = 320;

/**
 * The per-client cap on open blind tunnels: proxy.maxTunnelsPerClient, 0 for
 * none, the default when unset or not a whole number ≥ 0.
 * @param {any} proxyConfig
 */
export function maxTunnelsPerClient(proxyConfig) {
  const v = proxyConfig?.maxTunnelsPerClient;
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_MAX_TUNNELS_PER_CLIENT;
}

export class TunnelStats {
  constructor(now = () => Date.now()) {
    this._now = now;
    /** @type {Map<string, number>} client → open tunnels now */
    this._active = new Map();
    /** @type {Map<string, number>} client → most open at once since start */
    this._peak = new Map();
    /** @type {Map<number, Map<string, number>>} hour index → client → most open at once in that hour */
    this._hours = new Map();
    /** @type {Map<string, number>} client → tunnels refused by the cap since start */
    this._refused = new Map();
  }

  /** Tunnels this client has open now. @param {string|null|undefined} client */
  active(client) { return this._active.get(TunnelStats.key(client)) || 0; }

  /** A tunnel refused by the cap. @param {string|null|undefined} client */
  refuse(client) {
    const k = TunnelStats.key(client);
    this._refused.set(k, (this._refused.get(k) || 0) + 1);
  }

  /** @param {string|null|undefined} client */
  static key(client) { return client || '(shared key)'; }

  /** A tunnel opened; returns its close function (idempotent). @param {string|null|undefined} client */
  open(client) {
    const k = TunnelStats.key(client);
    const n = (this._active.get(k) || 0) + 1;
    this._active.set(k, n);
    if (n > (this._peak.get(k) || 0)) this._peak.set(k, n);
    const h = Math.floor(this._now() / HOUR_MS);
    let bucket = this._hours.get(h);
    if (!bucket) {
      bucket = new Map();
      this._hours.set(h, bucket);
      for (const old of this._hours.keys()) if (old <= h - 24) this._hours.delete(old);
    }
    if (n > (bucket.get(k) || 0)) bucket.set(k, n);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const left = (this._active.get(k) || 1) - 1;
      if (left > 0) this._active.set(k, left); else this._active.delete(k);
    };
  }

  snapshot() {
    const h = Math.floor(this._now() / HOUR_MS);
    /** @type {Record<string, number>} */
    const peak24h = {};
    for (const [hour, bucket] of this._hours) {
      if (hour <= h - 24) continue;
      for (const [k, n] of bucket) peak24h[k] = Math.max(peak24h[k] || 0, n);
    }
    return {
      active: Object.fromEntries(this._active),
      peakSinceStart: Object.fromEntries(this._peak),
      peak24h,
      refusedSinceStart: Object.fromEntries(this._refused),
    };
  }
}
