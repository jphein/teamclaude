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
    templateTokens: Number.isInteger(f?.templateTokens) && f.templateTokens >= 0 ? f.templateTokens : 2048,
    // Largest prompt failover will serve. A cold prefill of a long prompt holds
    // the local GPU's single slot for minutes and stalls its other users (HA
    // voice). Stays 64000; raise to 120000 only when BOTH hold: HA enforces an
    // entity allow-list, and a gpu1 HA config passes the safety gate ×10.
    maxPromptTokens: Number.isInteger(f?.maxPromptTokens) && f.maxPromptTokens > 0 ? f.maxPromptTokens : 64000,
  };
}

/** The least room an answer needs in the local window. */
export const MIN_ANSWER_TOKENS = 1024;

/**
 * Rough input size of a request body in tokens. JSON with tool schemas and
 * prose runs ~4 bytes per token; digit-heavy text is denser, so this is an
 * estimate the local server's own refusal backs up, not a guarantee.
 * @param {number} bytes
 */
export function estimateInputTokens(bytes) { return Math.ceil(bytes / 4); }

/** Shared failover state for one proxy (plain, MITM and h2 listeners alike). */
export class FailoverState {
  constructor(now = () => Date.now()) {
    this._now = now;
    /** @type {number|null} when the fleet was first seen unable to serve */
    this.unavailableSince = null;
    /** @type {number|null} */
    this.lastUnservableAt = null;
    this.inFlight = 0;
    this.served = 0;
    this.refused = 0;
    /** @type {number|null} */
    this.lastAt = null;
    /** @type {string|null} */
    this.lastClient = null;
    /** Sessions a local model answered, with when: the only conversations
     * prepareForClaude may repair (provenance, not a guess from the body).
     * @type {Map<string, number>} */
    this.sessions = new Map();
    /** tool_use ids the local model emitted: per-turn evidence for the repair.
     * @type {Set<string>} */
    this.localToolIds = new Set();
  }
  /**
   * Record the tool_use ids in a local response, read structurally (any key
   * order): a JSON message's content blocks, or each SSE event's content block.
   * @param {string} text
   */
  noteLocalToolIds(text) {
    /** @param {any} block */
    const take = (block) => { if (block && block.type === 'tool_use' && typeof block.id === 'string') this.localToolIds.add(block.id); };
    /** @param {any} obj */
    const fromObj = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      take(obj.content_block);
      if (Array.isArray(obj.content)) for (const b of obj.content) take(b);
      if (obj.message && Array.isArray(obj.message.content)) for (const b of obj.message.content) take(b);
    };
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{')) {
      try { fromObj(JSON.parse(trimmed)); } catch { /* not one JSON document: read it as SSE below */ }
    }
    // SSE: an event's data may span several data: lines, joined with "\n" and
    // ended by a blank line — parse per event, not per line.
    /** @type {string[]} */
    let data = [];
    const flush = () => { if (data.length) { try { fromObj(JSON.parse(data.join('\n'))); } catch { /* not JSON */ } data = []; } };
    for (const line of text.split(/\r?\n/)) {
      if (line === '') { flush(); continue; }
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    flush();
    // Bounded: drop the oldest beyond 20000 (Set keeps insertion order).
    for (const id of this.localToolIds) { if (this.localToolIds.size <= 20000) break; this.localToolIds.delete(id); }
  }
  /** @param {string|null|undefined} sessionId */
  noteServedSession(sessionId) {
    // In memory: after a restart a returning conversation is not repaired (a
    // turn mid tool-loop may then get one 400 from Claude before it moves on).
    if (!sessionId) return;
    const now = this._now();
    this.sessions.delete(sessionId);   // re-insert: an active session is the newest, never the first evicted
    this.sessions.set(sessionId, now);
    // Bounded: forget sessions older than a day, and keep at most 5000.
    if (this.sessions.size > 5000) for (const [k, t] of this.sessions) { if (now - t > 86_400_000 || this.sessions.size > 5000) this.sessions.delete(k); else break; }
  }
  /** @param {string|null|undefined} sessionId */
  servedLocally(sessionId) {
    const t = sessionId ? this.sessions.get(sessionId) : undefined;
    return t != null && this._now() - t < 86_400_000;
  }
  /** An account answered a request successfully: the fleet is back. */
  noteServable() { this.unavailableSince = null; }
  /**
   * No account could serve this request. A clock left running by an old blip
   * (nothing succeeded afterwards to reset it) restarts after a quiet gap, so a
   * momentary throttle hours later is not mistaken for a long outage.
   * @param {number} [quietGapMs] @returns {number} ms the fleet has been unservable
   */
  noteUnservable(quietGapMs = 60_000) {
    const now = this._now();
    if (this.lastUnservableAt != null && now - this.lastUnservableAt > quietGapMs) this.unavailableSince = null;
    this.lastUnservableAt = now;
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
  // Best effort, not a guarantee (see estimateInputTokens). A request that
  // still overflows is rejected by the local server, which serveFromFailover
  // turns into a 429.
  // Fit is decided by the local tokenizer in serveFromFailover (the byte
  // estimate only when it cannot be asked), not here.
  if (a.state.inFlight >= policy.maxConcurrent) return { ok: false, why: `local model busy (${a.state.inFlight}/${policy.maxConcurrent})` };
  return { ok: true };
}

/**
 * The request body as the local model gets it: its model name, no thinking
 * (its blocks would be unsigned), and no unsigned thinking from earlier turns.
 * max_tokens is clamped to the room the input leaves in the local window.
 * @param {Buffer} body @param {string} model @param {number} [contextTokens]
 * @param {number|null} [inputTokens]  the local tokenizer's count, when known
 * @returns {Buffer|null} null when the body is not a JSON object
 */
export function bodyForFailover(body, model, contextTokens = 131072, inputTokens = null) {
  let obj;
  try { obj = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  obj.model = model;
  const room = contextTokens - (inputTokens ?? estimateInputTokens(body.length));
  if (Number.isFinite(obj.max_tokens) && obj.max_tokens > room) obj.max_tokens = Math.max(MIN_ANSWER_TOKENS, room);
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
    if (kept.length !== m.content.length) {
      // A message that held only unsigned thinking must not become empty: the
      // API rejects empty content.
      m.content = kept.length ? kept : [{ type: 'text', text: '(no content)' }];
      changed = true;
    }
  }
  return changed;
}

/**
 * A conversation that comes back to Claude after failover turns, repaired so
 * Claude accepts it:
 *   * unsigned thinking blocks (from a local model) are removed — Claude
 *     rejects a thinking block whose signature it cannot verify;
 *   * with thinking enabled, the last assistant turn must open with a thinking
 *     block when it carries tool_use; a local turn never does, so when that
 *     turn is provably local (its tool_use id is one the local model was
 *     recorded emitting) thinking is switched off for that one request instead
 *     of answering 400.
 * Called only for sessions FailoverState.servedLocally() knows a local model
 * answered (provenance); every other conversation is never touched. Within
 * such a session, anything that needs no repair is left byte-for-byte.
 * @param {Buffer} body @param {(id: string) => boolean} [isLocalToolId]
 * @returns {{ body: Buffer, changed: boolean, droppedThinking: boolean }}
 */
export function prepareForClaude(body, isLocalToolId = () => false) {
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
    // Only on evidence the turn is the local model's: a tool_use id the local
    // model was recorded emitting (FailoverState.noteLocalToolIds). Never
    // because thinking is merely absent — under adaptive thinking Claude may
    // skip it on a turn — and never from an id's naming convention.
    const localToolUse = blocks && blocks.some((/** @type {any} */ b) => b?.type === 'tool_use' && typeof b.id === 'string' && isLocalToolId(b.id));
    if (localToolUse && !(blocks[0]?.type === 'thinking' || blocks[0]?.type === 'redacted_thinking')) {
      delete obj.thinking;
      droppedThinking = true;
      changed = true;
    }
  }
  return changed ? { body: Buffer.from(JSON.stringify(obj), 'utf8'), changed, droppedThinking } : same;
}

/**
 * The input size for the local window: the local server's own count of the
 * request JSON (llama-server /tokenize) plus 5%, plus a fixed allowance for
 * its chat template's framing (failover.templateTokens). The JSON carries the
 * tool schemas and content the template renders, so this bounds the prompt
 * for the supported templates. null when it cannot be asked — the caller then
 * uses the byte estimate plus the same allowance.
 * @param {ReturnType<typeof failoverPolicy>} policy @param {string} text @param {AbortSignal} [signal]
 * @returns {Promise<number|null>}
 */
export async function countLocalTokens(policy, text, signal) {
  try {
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json' };
    if (policy.apiKey) { headers['x-api-key'] = policy.apiKey; headers.authorization = `Bearer ${policy.apiKey}`; }
    const sigs = [AbortSignal.timeout(15_000)];
    if (signal) sigs.push(signal);
    const r = await fetch(`${policy.url}/tokenize`, { method: 'POST', headers, body: JSON.stringify({ content: text }), signal: AbortSignal.any(sigs), redirect: 'error' });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
    const j = /** @type {any} */ (await r.json());
    return Array.isArray(j?.tokens) ? Math.ceil(j.tokens.length * 1.05) + policy.templateTokens : null;
  } catch { return null; }
}
