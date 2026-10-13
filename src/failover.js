// Local-model failover (JP, 2026-10-12): "automatically fail over when we run
// out of all Claude tokens". When no account can serve a request, it is served
// by a local model (llama-server's native Anthropic /v1/messages, or anything
// speaking it — LiteLLM included) instead of a 429, so agents degrade to slower
// and weaker instead of stopping. Fail-back is automatic: every request tries
// the Claude accounts first, and failover only answers what they cannot.
//
// Guards, each for a way the switch could hurt:
//   * hysteresis — only after the fleet has been unservable for afterSeconds,
//     or at once when every account is out of quota (nothing to wait for), so a
//     momentary 429 burst never drops a session onto the weak model;
//   * capacity — at most maxConcurrent failover requests (the local server has
//     few slots and other users); the rest get today's 429 and back off;
//   * context — a request that cannot fit the local window is not sent there;
//   * thinking — the local model is asked not to think (its thinking blocks
//     carry no signature, which Claude rejects after fail-back), and
//     prepareForClaude() repairs a conversation that came back from failover.
// Visibility: x-teamclaude-failover response header, the local model's own
// name in the response, a log line per request, and `failover` in status.

/** @param {any} config */
export function failoverPolicy(config) {
  const f = config?.failover;
  const on = !!(f && typeof f === 'object' && f.enabled === true && typeof f.url === 'string' && f.url.trim());
  return {
    enabled: on,
    url: on ? String(f.url).trim().replace(/\/+$/, '') : null,
    model: typeof f?.model === 'string' && f.model.trim() ? f.model.trim() : 'qwen36-coder',
    apiKey: typeof f?.apiKey === 'string' && f.apiKey ? f.apiKey : null,
    afterSeconds: Number.isFinite(f?.afterSeconds) && f.afterSeconds >= 0 ? f.afterSeconds : 20,
    maxConcurrent: Number.isInteger(f?.maxConcurrent) && f.maxConcurrent >= 1 ? f.maxConcurrent : 1,
    contextTokens: Number.isInteger(f?.contextTokens) && f.contextTokens > 0 ? f.contextTokens : 131072,
    timeoutSeconds: Number.isFinite(f?.timeoutSeconds) && f.timeoutSeconds > 0 ? f.timeoutSeconds : 600,
  };
}

/** Shared failover state for one proxy (plain, MITM and h2 listeners alike). */
export class FailoverState {
  constructor(now = () => Date.now()) {
    this._now = now;
    /** @type {number|null} when the fleet was first seen unable to serve */
    this.unavailableSince = null;
    this.inFlight = 0;
    this.served = 0;
    this.refused = 0;
    /** @type {number|null} */
    this.lastAt = null;
    /** @type {string|null} */
    this.lastClient = null;
  }
  /** An account served (or was selected for) a request: the fleet is back. */
  noteServable() { this.unavailableSince = null; }
  /** No account could serve this request. @returns {number} ms the fleet has been unservable */
  noteUnservable() {
    const now = this._now();
    this.unavailableSince ??= now;
    return now - this.unavailableSince;
  }
  /** @param {ReturnType<typeof failoverPolicy>} policy */
  snapshot(policy) {
    const now = this._now();
    return {
      enabled: policy.enabled,
      model: policy.model,
      active: policy.enabled && this.lastAt != null && this.unavailableSince != null && now - this.lastAt < 120_000,
      since: this.unavailableSince != null ? new Date(this.unavailableSince).toISOString() : null,
      served: this.served,
      refused: this.refused,
      inFlight: this.inFlight,
      lastAt: this.lastAt != null ? new Date(this.lastAt).toISOString() : null,
      lastClient: this.lastClient,
    };
  }
}

/**
 * Whether this request may fail over now, and if not, why (for the log).
 * @param {{ policy: ReturnType<typeof failoverPolicy>, state: FailoverState, method?: string, url?: string,
 *   provider?: string, pinned?: boolean, allQuota: boolean, unservableMs: number, bodyBytes: number,
 *   maxTokens?: number, contentEncoding?: string|null }} a
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function failoverEligibility(a) {
  const { policy } = a;
  if (!policy.enabled) return { ok: false, why: 'off' };
  if (a.method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(a.url || '')) return { ok: false, why: 'not a messages request' };
  if (a.provider && a.provider !== 'anthropic') return { ok: false, why: 'not an Anthropic request' };
  if (a.pinned) return { ok: false, why: 'pinned to one account' };
  if (a.contentEncoding && a.contentEncoding !== 'identity') return { ok: false, why: 'compressed body' };
  if (!a.allQuota && a.unservableMs < policy.afterSeconds * 1000) return { ok: false, why: `fleet unservable for ${Math.round(a.unservableMs / 1000)}s < ${policy.afterSeconds}s` };
  // ~3.5 bytes per token is a conservative (over-)estimate for English/code JSON.
  const estTokens = Math.ceil(a.bodyBytes / 3.5) + (a.maxTokens || 0);
  if (estTokens > policy.contextTokens) return { ok: false, why: `~${estTokens} tokens exceeds the local window (${policy.contextTokens})` };
  if (a.state.inFlight >= policy.maxConcurrent) return { ok: false, why: `local model busy (${a.state.inFlight}/${policy.maxConcurrent})` };
  return { ok: true };
}

/**
 * The request body as the local model gets it: its model name, no thinking
 * (its blocks would be unsigned), and no unsigned thinking from earlier turns.
 * @param {Buffer} body @param {string} model
 * @returns {Buffer|null} null when the body is not a JSON object
 */
export function bodyForFailover(body, model) {
  let obj;
  try { obj = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  obj.model = model;
  delete obj.thinking;
  obj.chat_template_kwargs = { ...(obj.chat_template_kwargs || {}), enable_thinking: false };
  stripUnsignedThinking(obj);
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

/** Remove thinking blocks with no signature from every message. @param {any} obj @returns {boolean} changed */
function stripUnsignedThinking(obj) {
  let changed = false;
  for (const m of Array.isArray(obj?.messages) ? obj.messages : []) {
    if (!Array.isArray(m?.content)) continue;
    const kept = m.content.filter((/** @type {any} */ b) => !(b && b.type === 'thinking' && !b.signature));
    if (kept.length !== m.content.length) { m.content = kept; changed = true; }
  }
  return changed;
}

/**
 * A conversation that comes back to Claude after failover turns, repaired so
 * Claude accepts it:
 *   * unsigned thinking blocks (from a local model) are removed — Claude
 *     rejects a thinking block whose signature it cannot verify;
 *   * with thinking enabled, the last assistant turn must open with a thinking
 *     block when it carries tool_use; a local turn never does, so for that one
 *     request thinking is switched off instead of answering 400.
 * Anything else — and any body that never saw failover — is left byte-for-byte.
 * @param {Buffer} body
 * @returns {{ body: Buffer, changed: boolean, droppedThinking: boolean }}
 */
export function prepareForClaude(body) {
  const same = { body, changed: false, droppedThinking: false };
  const text = body.toString('utf8');
  if (!text.includes('"thinking"') && !text.includes('"tool_use"')) return same;
  let obj;
  try { obj = JSON.parse(text); } catch { return same; }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.messages)) return same;
  let changed = stripUnsignedThinking(obj);
  let droppedThinking = false;
  const thinkingOn = obj.thinking && typeof obj.thinking === 'object' && obj.thinking.type && obj.thinking.type !== 'disabled';
  if (thinkingOn) {
    const lastAssistant = [...obj.messages].reverse().find((/** @type {any} */ m) => m?.role === 'assistant');
    const blocks = Array.isArray(lastAssistant?.content) ? lastAssistant.content : null;
    if (blocks && blocks.some((/** @type {any} */ b) => b?.type === 'tool_use')
      && !(blocks[0]?.type === 'thinking' || blocks[0]?.type === 'redacted_thinking')) {
      delete obj.thinking;
      droppedThinking = true;
      changed = true;
    }
  }
  return changed ? { body: Buffer.from(JSON.stringify(obj), 'utf8'), changed, droppedThinking } : same;
}
