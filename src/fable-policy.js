import zlib from 'node:zlib';

// Fable rationing (JP, 2026-10-11): "you and my claudes should use fable".
//
// Only clients named in `fable.allow` — per-client key names from
// proxy.clientKeys — may use a Fable model. Everyone else's Fable request is
// served as `fable.model` (Opus by default): the model is rewritten before
// routing, never refused, so no lane breaks. An allowed client falls back the
// same way when no account has Fable allowance left, or when upstream answers
// Fable with 529 "overloaded" (JP: "and ii for sure").
//
// Identity is the authenticating key only. familiar's forwarder keeps a
// caller's own key and injects familiar's when there is none, so a lane that
// sends nothing is "familiar"; host, headers and session titles are shared or
// forgeable and are never consulted. The shared proxy key and key-less callers
// have no client name and are not allowed unless the list says "(shared key)".

/** The list entry that admits the shared proxy key / key-less callers. */
export const SHARED_KEY_ENTRY = '(shared key)';
export const DEFAULT_FABLE_MODEL = 'claude-opus-5-5';
/** Deeper than any real request; past it inspection would give up, so the body is refused. */
export const MAX_DEPTH = 256;
/** Default cap on a decoded body (the proxy's own default request limit). */
export const DEFAULT_DECODED_MAX = 64 * 1024 * 1024;

/** The first Fable model a body asks for anywhere (decoded, parsed, every `model` key), or null. @param {Buffer} body @param {string|string[]|undefined|null} [contentEncoding] @param {number} [maxBytes] */
export function fableModelIn(body, contentEncoding = null, maxBytes = DEFAULT_DECODED_MAX) {
  return rewriteFableBody(body, DEFAULT_FABLE_MODEL, contentEncoding, maxBytes).found;
}

/** @param {unknown} model */
export function isFableModel(model) {
  return typeof model === 'string' && /fable/i.test(model);
}

/**
 * The policy as configured. With no `fable.allow` list, rationing is off and
 * everything passes — the behaviour before this feature. An empty list allows
 * nobody (fail closed).
 * @param {any} config
 * @returns {{ enabled: boolean, allow: Set<string>, model: string }}
 */
export function fablePolicy(config) {
  const f = config?.fable;
  // Rationing is on only when an allow LIST is configured: clearing the list in
  // Settings (leaving `fable: {}`), or setting only fable.model, must turn it
  // off, not silently deny Fable to everyone.
  if (!f || typeof f !== 'object' || !Array.isArray(f.allow)) return { enabled: false, allow: new Set(), model: DEFAULT_FABLE_MODEL };
  const allow = new Set((Array.isArray(f.allow) ? f.allow : []).filter((/** @type {unknown} */ n) => typeof n === 'string').map((/** @type {string} */ n) => n.trim()));
  const model = typeof f.model === 'string' && f.model.trim() && !isFableModel(f.model) ? f.model.trim() : DEFAULT_FABLE_MODEL;
  return { enabled: true, allow, model };
}

/** @param {{ allow: Set<string> }} policy @param {string|null|undefined} client */
export function clientAllowed(policy, client) {
  return client ? policy.allow.has(client) : policy.allow.has(SHARED_KEY_ENTRY);
}

/**
 * What to do with one request.
 *  pass     — not Fable, rationing off, or allowed with Fable available
 *  rewrite  — a client not on the list: serve as `to`
 *  fallback — an allowed client, but no account can serve Fable: serve as `to`
 * @param {{ policy: ReturnType<typeof fablePolicy>, model: unknown, advisorModel?: unknown, client?: string|null, fableAvailable: () => boolean }} a
 * @returns {{ action: 'pass'|'rewrite'|'fallback', to?: string }}
 */
export function decideFable({ policy, model, advisorModel = null, client = null, fableAvailable }) {
  if (!policy.enabled || !(isFableModel(model) || isFableModel(advisorModel))) return { action: 'pass' };
  if (!clientAllowed(policy, client)) return { action: 'rewrite', to: policy.model };
  if (!fableAvailable()) return { action: 'fallback', to: policy.model };
  return { action: 'pass' };
}

/**
 * The request body with every Fable model replaced by `to` — the enforcement
 * point, run up front and again on the exact bytes of every upstream attempt.
 *
 * Every property named `model` anywhere in the JSON is checked, not only the
 * top-level one: advisor tools (tools[].model), batch items
 * (requests[].params.model), anything. Upstream must see exactly what was
 * checked, so a body that could hide a Fable model from this parser — a
 * duplicate "model" key (JSON.parse keeps the last; another parser may keep
 * the first), a \\u escape, or any literal "fable" in the text — is
 * re-serialised from the parsed object, which leaves one canonical model per
 * object. A body with neither can spell no Fable model in any parser and is
 * passed through byte-for-byte (re-serialising would round large numbers).
 *
 * A compressed body (gzip, deflate, br, zstd) is decoded first; when it needs a
 * rewrite it is sent decoded, and dropEncoding tells the caller to remove
 * Content-Encoding. An encoding this cannot decode is `refuse`: the caller
 * answers 415 rather than forward a body nobody inspected.
 * A body that may carry a Fable model but cannot be inspected — undecodable,
 * larger than `maxBytes` once decoded (a compression bomb), not parseable
 * JSON, or nested deeper than MAX_DEPTH — is `refuse` too: inspection that
 * gives up must not let the request through.
 * @param {Buffer} body @param {string} to @param {string|string[]|undefined|null} [contentEncoding]
 * @param {number} [maxBytes]  cap on the decoded size (the proxy's body limit)
 * @returns {{ body: Buffer, changed: boolean, found: string|null, dropEncoding: boolean, refuse: boolean }}
 */
export function rewriteFableBody(body, to, contentEncoding = null, maxBytes = DEFAULT_DECODED_MAX) {
  const enc = String(Array.isArray(contentEncoding) ? contentEncoding.join(',') : contentEncoding ?? '').trim().toLowerCase();
  const none = { body, changed: false, found: null, dropEncoding: false, refuse: false };
  let raw = body;
  if (enc && enc !== 'identity') {
    const decoded = decodeBody(body, enc, maxBytes);
    if (!decoded) return { ...none, refuse: true };
    raw = decoded;
  }
  const text = raw.toString('utf8');
  if (!/fable|\\u[0-9a-f]{4}/i.test(text)) return none;      // no parser can read a Fable model here
  let obj;
  // A leading BOM is legal JSON to some parsers and not to JSON.parse; it is
  // dropped (the canonical body carries none). Any other parse failure on a
  // body that could spell a Fable model is refused rather than forwarded.
  try { obj = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return { ...none, refuse: true }; }
  if (!obj || typeof obj !== 'object') return none;
  /** @type {string|null} */
  let found = null;
  let tooDeep = false;
  /** @param {any} node @param {number} depth */
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || tooDeep) return;
    if (depth > MAX_DEPTH) { tooDeep = true; return; }
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    for (const k of Object.keys(node)) {
      if (k === 'model' && isFableModel(node[k])) { found ??= node[k]; node[k] = to; }
      else walk(node[k], depth + 1);
    }
  };
  walk(obj, 0);
  if (tooDeep) return { ...none, refuse: true };
  const canonical = Buffer.from(JSON.stringify(obj), 'utf8');
  const decodedAway = raw !== body;
  // Unchanged and nothing ambiguous: keep the client's exact bytes (and encoding).
  if (!found && canonical.equals(Buffer.from(text, 'utf8'))) return none;
  return { body: canonical, changed: true, found, dropEncoding: decodedAway, refuse: false };
}

/** Bounded: each stage stops at maxBytes (maxOutputLength), so a small
 * compressed body cannot expand past the size the proxy accepts uncompressed.
 * @param {Buffer} body @param {string} enc @param {number} maxBytes */
function decodeBody(body, enc, maxBytes) {
  try {
    const z = /** @type {any} */ (zlib);
    let out = body;
    // Applied in reverse of the order listed ("gzip, br" = gzip first, then br).
    for (const e of enc.split(',').map((x) => x.trim()).filter(Boolean).reverse()) {
      if (e === 'identity') continue;
      const opts = { maxOutputLength: maxBytes };
      if (e === 'gzip' || e === 'x-gzip') out = zlib.gunzipSync(out, opts);
      else if (e === 'deflate') out = zlib.inflateSync(out, opts);
      else if (e === 'br') out = zlib.brotliDecompressSync(out, opts);
      else if (e === 'zstd' && typeof z.zstdDecompressSync === 'function') out = z.zstdDecompressSync(out, opts);
      else return null;
    }
    return out;
  } catch { return null; }
}

/**
 * Today's counters for the dashboard (local day; reset at midnight). In memory:
 * a restart starts the day's count again.
 */
export class FableStats {
  constructor(now = () => new Date()) {
    this._now = now;
    this.day = '';
    this.rewritten = 0;
    this.fallbacks = 0;
    /** @type {{ at: string, client: string|null, from: string, to: string, reason: string } | null} */
    this.lastFallback = null;
    this._reset();
  }
  _reset() {
    this.day = this._now().toLocaleDateString('en-CA');
    this.rewritten = 0;
    this.fallbacks = 0;
    /** @type {{ at: string, client: string|null, from: string, to: string, reason: string } | null} */
    this.lastFallback = null;
  }
  _roll() { if (this._now().toLocaleDateString('en-CA') !== this.day) this._reset(); }
  /** @param {'rewrite'|'fallback'} kind @param {{ client: string|null, from: string, to: string, reason: string }} info */
  record(kind, info) {
    this._roll();
    if (kind === 'rewrite') this.rewritten++;
    else { this.fallbacks++; this.lastFallback = { at: this._now().toISOString(), ...info }; }
  }
  snapshot() {
    this._roll();
    return { day: this.day, rewritten: this.rewritten, fallbacks: this.fallbacks, lastFallback: this.lastFallback };
  }
}
