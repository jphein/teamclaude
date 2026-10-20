import zlib from 'node:zlib';

// Per-family model rationing: Fable (JP, 2026-10-11: "you and my claudes
// should use fable") and Mythos (JP, 2026-10-20: "we need to add mythos
// support to teamclaude … and fable"). Each family is configured the same way,
// under its own config key:
//
//   "<family>": { "allow": ["jp-92", …], "model": "claude-opus-5-5", "fallbackOnCapacity": true }
//
// Only clients named in `allow` — per-client key names from proxy.clientKeys —
// may use the family. Everyone else's request is served as `model`: the model
// is rewritten before routing, never refused, so no lane breaks. An allowed
// client falls back the same way when no account can serve the family, and
// (unless `fallbackOnCapacity` is false) when upstream answers it with 529.
//
// Identity is the authenticating key only. familiar's forwarder keeps a
// caller's own key and injects familiar's when there is none, so a lane that
// sends nothing is "familiar"; host, headers and session titles are shared or
// forgeable and are never consulted. The shared proxy key and key-less callers
// have no client name and are not allowed unless the list says "(shared key)".

/** The list entry that admits the shared proxy key / key-less callers. */
export const SHARED_KEY_ENTRY = '(shared key)';
/** Default cap on a decoded body (the proxy's own default request limit). */
export const DEFAULT_DECODED_MAX = 64 * 1024 * 1024;

/**
 * The rationed families, in the order their policies run. Mythos first: its
 * fallback may be a Fable model, and Fable's list must then judge that.
 * @type {ReadonlyArray<{ name: 'mythos'|'fable', label: string, test: RegExp, defaultModel: string }>}
 */
export const FAMILIES = Object.freeze([
  Object.freeze({ name: /** @type {'mythos'} */ ('mythos'), label: 'Mythos', test: /mythos/i, defaultModel: 'claude-opus-5-5' }),
  Object.freeze({ name: /** @type {'fable'} */ ('fable'), label: 'Fable', test: /fable/i, defaultModel: 'claude-opus-5-5' }),
]);

/** @param {string} family */
export function familyDef(family) {
  const d = FAMILIES.find((f) => f.name === family);
  if (!d) throw new Error(`unknown rationed family: ${family}`);
  return d;
}

/** @param {string} family @param {unknown} model */
export function isFamilyModel(family, model) {
  return typeof model === 'string' && familyDef(family).test.test(model);
}

/**
 * The policy as configured. With no `allow` list, rationing is off and
 * everything passes. An empty list allows nobody (fail closed).
 * @param {any} config @param {string} family
 * @returns {{ family: string, label: string, enabled: boolean, allow: Set<string>, model: string, fallbackOnCapacity: boolean }}
 */
export function familyPolicy(config, family) {
  const d = familyDef(family);
  const f = config?.[family];
  const fallbackOnCapacity = !(f && typeof f === 'object' && f.fallbackOnCapacity === false);
  // Rationing is on only when an allow LIST is configured: clearing the list in
  // Settings (leaving `<family>: {}`), or setting only `model`, must turn it
  // off, not silently deny the family to everyone.
  if (!f || typeof f !== 'object' || !Array.isArray(f.allow)) {
    return { family, label: d.label, enabled: false, allow: new Set(), model: d.defaultModel, fallbackOnCapacity };
  }
  const allow = new Set(f.allow.filter((/** @type {unknown} */ n) => typeof n === 'string').map((/** @type {string} */ n) => n.trim()));
  const model = typeof f.model === 'string' && f.model.trim() && fallbackAllowed(family, f.model) ? f.model.trim() : d.defaultModel;
  return { family, label: d.label, enabled: true, allow, model, fallbackOnCapacity };
}

/**
 * May `family` fall back to `model`? Never to itself (a rationed request would
 * be served as itself), and never to a family whose gate has already run:
 * gates run in FAMILIES order, once, so a fallback into an EARLIER family
 * (Fable → Mythos) would reach upstream unchecked. Mythos → Fable is fine.
 * @param {string} family @param {unknown} model
 */
export function fallbackAllowed(family, model) {
  if (typeof model !== 'string') return false;
  const at = FAMILIES.findIndex((f) => f.name === family);
  return !FAMILIES.some((f, i) => i <= at && f.test.test(model));
}

/** @param {{ allow: Set<string> }} policy @param {string|null|undefined} client */
export function clientAllowed(policy, client) {
  return client ? policy.allow.has(client) : policy.allow.has(SHARED_KEY_ENTRY);
}

/**
 * What to do with one request.
 *  pass     — not this family, rationing off, or allowed with the family available
 *  rewrite  — a client not on the list: serve as `to`
 *  fallback — an allowed client, but no account can serve the family: serve as `to`
 * @param {{ policy: ReturnType<typeof familyPolicy>, model: unknown, advisorModel?: unknown, client?: string|null, available: () => boolean }} a
 * @returns {{ action: 'pass'|'rewrite'|'fallback', to?: string }}
 */
export function decideFamily({ policy, model, advisorModel = null, client = null, available }) {
  if (!policy.enabled || !(isFamilyModel(policy.family, model) || isFamilyModel(policy.family, advisorModel))) return { action: 'pass' };
  if (!clientAllowed(policy, client)) return { action: 'rewrite', to: policy.model };
  if (!available()) return { action: 'fallback', to: policy.model };
  return { action: 'pass' };
}

/**
 * The first model of `family` a body asks for anywhere (decoded, parsed, every `model` key), or null.
 * @param {string} family @param {Buffer} body @param {string|string[]|undefined|null} [contentEncoding]
 * @param {number} [maxBytes] @param {string|string[]|undefined|null} [contentType]
 */
export function familyModelIn(family, body, contentEncoding = null, maxBytes = DEFAULT_DECODED_MAX, contentType = null) {
  return rewriteFamilyBody(family, body, familyDef(family).defaultModel, contentEncoding, maxBytes, contentType).found;
}

/**
 * The request body with every model of `family` replaced by `to` — the
 * enforcement point, run up front and again on the exact bytes of every
 * upstream attempt.
 *
 * Every `model` key anywhere is checked (keys in any case) except inside the
 * conversation (messages, system): the known places — advisor tools, batch
 * items' params — and any place upstream reads a model that this code does
 * not know about. Upstream must see exactly what was checked, so a body that
 * could hide a family model from this parser — a duplicate "model" key
 * (JSON.parse keeps the last; another parser may keep the first), a \\u
 * escape, or any literal family name in the text — is re-serialised from the
 * parsed object, which leaves one canonical model per object. A body with
 * neither can spell no family model in any parser and is passed through
 * byte-for-byte (re-serialising would round large numbers).
 *
 * A compressed body (gzip, deflate, br, zstd) is decoded first; when it needs a
 * rewrite it is sent decoded, and dropEncoding tells the caller to remove
 * Content-Encoding. An encoding this cannot decode is `refuse`: the caller
 * answers 415 rather than forward a body nobody inspected.
 * A body that may carry a family model but cannot be inspected — undecodable,
 * larger than `maxBytes` once decoded (a compression bomb), not parseable
 * JSON-typed or JSON-shaped yet unparseable — is `refuse` too: inspection that
 * gives up must not let the request through.
 * @param {string} family @param {Buffer} body @param {string} to @param {string|string[]|undefined|null} [contentEncoding]
 * @param {number} [maxBytes]  cap on the decoded size (the proxy's body limit)
 * @param {string|string[]|undefined|null} [contentType]  a body that is neither JSON-typed nor JSON-shaped is not parsed
 * @returns {{ body: Buffer, changed: boolean, found: string|null, dropEncoding: boolean, refuse: boolean }}
 */
export function rewriteFamilyBody(family, body, to, contentEncoding = null, maxBytes = DEFAULT_DECODED_MAX, contentType = null) {
  const re = familyDef(family).test;
  /** @param {unknown} m */
  const isTarget = (m) => typeof m === 'string' && re.test(m);
  const enc = String(Array.isArray(contentEncoding) ? contentEncoding.join(',') : contentEncoding ?? '').trim().toLowerCase();
  const none = { body, changed: false, found: null, dropEncoding: false, refuse: false };
  let raw = body;
  if (enc && enc !== 'identity') {
    const decoded = decodeBody(body, enc, maxBytes);
    if (!decoded) return { ...none, refuse: true };
    raw = decoded;
  }
  const text = raw.toString('utf8');
  // No parser can read a family model here: neither the name nor an escape.
  if (!re.test(text) && !/\\u[0-9a-f]{4}/i.test(text)) return none;
  let obj;
  // A leading BOM is legal JSON to some parsers and not to JSON.parse; it is
  // dropped (the canonical body carries none). A body that claims to be JSON —
  // by type or by shape — and still fails to parse is refused rather than
  // forwarded; anything else (a multipart file upload) carries no model field.
  const unbommed = text.replace(/^﻿/, '');
  const ct = String(Array.isArray(contentType) ? contentType.join(',') : contentType ?? '').toLowerCase();
  const jsonish = ct.includes('json') || /^\s*[[{]/.test(unbommed);
  if (!jsonish) return none;
  try { obj = JSON.parse(unbommed); } catch { return { ...none, refuse: true }; }
  if (!obj || typeof obj !== 'object') return none;
  // Every `model` key at any depth (keys in any case) — except inside the
  // conversation (`messages`, `system`): a past tool_use input that names a
  // model is history, and rewriting it would change what the client said.
  // Everything else is checked, known places (tools[].model, a batch item's
  // params) and unknown ones alike, so a model field upstream reads that this
  // code has never heard of is still covered. Each batch item's params get the
  // same rule. An explicit stack: no recursion limit to give up at.
  /** @type {string|null} */
  let found = null;
  const CONVERSATION = new Set(['messages', 'system']);
  /** @param {any} root */
  const fixRequest = (root) => {
    /** @type {Array<{ node: any, top: boolean }>} */
    const stack = [{ node: root, top: true }];
    while (stack.length) {
      const { node, top } = /** @type {{ node: any, top: boolean }} */ (stack.pop());
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { for (const v of node) stack.push({ node: v, top: false }); continue; }
      for (const k of Object.keys(node)) {
        const lk = k.toLowerCase();
        if (lk === 'model' && isTarget(node[k])) { found ??= node[k]; node[k] = to; continue; }
        if (top && CONVERSATION.has(lk)) continue;
        if (top && lk === 'requests' && Array.isArray(node[k])) {
          // Batch items: each one's params is a request of its own (same rule);
          // anything else in the item is walked like any other field.
          for (const item of node[k]) {
            if (!item || typeof item !== 'object') continue;
            for (const ik of Object.keys(item)) {
              if (ik.toLowerCase() === 'params') stack.push({ node: item[ik], top: true });
              else if (ik.toLowerCase() === 'model' && isTarget(item[ik])) { found ??= item[ik]; item[ik] = to; }
              else stack.push({ node: item[ik], top: false });
            }
          }
          continue;
        }
        stack.push({ node: node[k], top: false });
      }
    }
  };
  fixRequest(obj);
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
 * A model upstream refused on THIS account (not a quota, not a throttle): a
 * 403 permission_error whose message names the exact model id. A generic
 * "does not have access to this model" is not enough: it may be the account
 * itself that is refused, which the entitlement path handles. It benches that exact model on that account only; the
 * account-wide entitlement cooldown would stop it serving Opus too.
 *
 * Only 403. A 404 not_found_error means the id itself is wrong, and any
 * client can send a made-up id: treating it as a refusal would let one
 * request for `claude-mythos-nonexistent` bench the family on every account.
 * @param {number} status @param {Buffer|string|null} body @param {string|null} model
 */
export function isFamilyRefusal(status, body, model) {
  if (status !== 403 || !body || !model) return false;
  let err;
  try { err = JSON.parse(String(body))?.error; } catch { return false; }
  if (String(err?.type || '') !== 'permission_error') return false;
  // As a whole id: "claude-mythos-5" must not match inside "claude-mythos-5-1".
  const id = model.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9._-])${id}($|[^a-z0-9._-])`).test(String(err?.message || '').toLowerCase());
}

/**
 * Today's counters for the dashboard (local day; reset at midnight), plus
 * rewrites and fallbacks per client over the last 24 hours (hourly buckets).
 * In memory: a restart starts both again.
 */
export class FamilyStats {
  constructor(now = () => new Date()) {
    this._now = now;
    this.day = '';
    this.rewritten = 0;
    this.fallbacks = 0;
    /** @type {{ at: string, client: string|null, from: string, to: string, reason: string } | null} */
    this.lastFallback = null;
    /** @type {Map<number, Map<string, { rewritten: number, fallbacks: number }>>} hour index → client → counts */
    this._hours = new Map();
    this._reset();
  }
  _reset() {
    this.day = this._now().toLocaleDateString('en-CA');
    this.rewritten = 0;
    this.fallbacks = 0;
    this.lastFallback = null;
  }
  _roll() { if (this._now().toLocaleDateString('en-CA') !== this.day) this._reset(); }
  _hour() { return Math.floor(this._now().getTime() / 3_600_000); }
  /** @param {'rewrite'|'fallback'} kind @param {{ client: string|null, from: string, to: string, reason: string }} info */
  record(kind, info) {
    this._roll();
    if (kind === 'rewrite') this.rewritten++;
    else { this.fallbacks++; this.lastFallback = { at: this._now().toISOString(), ...info }; }
    const h = this._hour();
    let bucket = this._hours.get(h);
    if (!bucket) { bucket = new Map(); this._hours.set(h, bucket); }
    const who = info.client ?? SHARED_KEY_ENTRY;
    const c = bucket.get(who) ?? { rewritten: 0, fallbacks: 0 };
    if (kind === 'rewrite') c.rewritten++; else c.fallbacks++;
    bucket.set(who, c);
    for (const k of this._hours.keys()) if (k <= h - 24) this._hours.delete(k);
  }
  snapshot() {
    this._roll();
    return { day: this.day, rewritten: this.rewritten, fallbacks: this.fallbacks, lastFallback: this.lastFallback };
  }
  /** Per client, the last 24 hours (the current hour and the 23 before it). */
  byClient24h() {
    const h = this._hour();
    /** @type {Record<string, { rewritten: number, fallbacks: number }>} */
    const out = {};
    for (const [k, bucket] of this._hours) {
      if (k <= h - 24) continue;
      for (const [who, c] of bucket) {
        const t = out[who] ?? (out[who] = { rewritten: 0, fallbacks: 0 });
        t.rewritten += c.rewritten;
        t.fallbacks += c.fallbacks;
      }
    }
    return out;
  }
}
