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

/** @param {unknown} model */
export function isFableModel(model) {
  return typeof model === 'string' && /fable/i.test(model);
}

/**
 * The policy as configured. With no `fable` block at all, rationing is off and
 * everything passes — the behaviour before this feature. A `fable` block with
 * an empty `allow` list allows nobody (fail closed).
 * @param {any} config
 * @returns {{ enabled: boolean, allow: Set<string>, model: string }}
 */
export function fablePolicy(config) {
  const f = config?.fable;
  if (!f || typeof f !== 'object') return { enabled: false, allow: new Set(), model: DEFAULT_FABLE_MODEL };
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
 * The request body with every Fable model replaced by `to`: the top-level
 * `model` and an advisor tool's nested `model` (tools[].model). Anything that
 * is not a JSON object is returned unchanged.
 * @param {Buffer} body @param {string} to
 * @returns {{ body: Buffer, changed: boolean }}
 */
export function rewriteFableBody(body, to) {
  let obj;
  try { obj = JSON.parse(body.toString('utf8')); } catch { return { body, changed: false }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { body, changed: false };
  let changed = false;
  if (isFableModel(obj.model)) { obj.model = to; changed = true; }
  if (Array.isArray(obj.tools)) {
    for (const t of obj.tools) {
      if (t && typeof t === 'object' && isFableModel(t.model)) { t.model = to; changed = true; }
    }
  }
  return changed ? { body: Buffer.from(JSON.stringify(obj), 'utf8'), changed } : { body, changed: false };
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
