// Banked Claude usage-limit resets: reading the grant a spent account holds, and
// spending one at the pool-dry refusal when the operator has armed
// `autoRedeemResets` — the same switch, the same moment and the same
// per-account exemption as the Codex reset credits.
//
// The Codex counterpart is codex-reset-credits.js. Anthropic's version differs
// in ways that matter for a call that cannot be undone:
//
//  - The grants live in the usage payload's `cedar_ember` block, which is only
//    filled in for a caller that asks with `?cedar_ember=1` and identifies as
//    Claude Code; anything else reads `eligible: false, ineligible_reason:
//    "surface"`, a statement about the caller and not the account.
//  - Spending names a grant, and only the payload's `next_grant_id` may be
//    spent; the endpoint is organization-scoped
//    (POST /api/organizations/<orgUuid>/reset_rate_limits), and the body is
//    `{ program: "cedar_ember", grant_id, request_id }`.
//  - The verdict is in the body's `result`: `reset` (spent, windows cleared),
//    `already_used` (this request id already went through), `not_limited`,
//    `cooldown`, `ineligible`, `unavailable` (nothing spent). A non-2xx or a
//    lost connection is no verdict at all, over a POST that may have spent the
//    grant — so the request id is kept and replayed, and the fleet holds off.
//
// Shapes read from Claude Code 2.1.290's own client and confirmed against a
// live redemption on 2026-10-10 (`result: "reset"`, `cleared: [five_hour,
// seven_day, seven_day_overage_included]`, `resets_left: 0`).

import { randomUUID } from 'node:crypto';

import { USAGE_URL, OAUTH_USAGE_BETA, USAGE_USER_AGENT, normalizeUsagePayload } from './oauth.js';
import { providerOf, DEFAULT_PROVIDER } from './provider.js';
import { safeLine } from './safe-text.js';
import { proxyFetch } from './upstream-fetch.js';

export const CLAUDE_RESET_PROGRAM = 'cedar_ember';
const RESET_HOST = 'https://api.anthropic.com';
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;

// After a spend that worked: long enough that one dry pool costs one reset,
// short enough that a pool dry again tomorrow is asked again.
const SUCCESS_HOLD_MS = 60 * 60 * 1000;
// After a verdict we never read: the grant may be spent, so nothing else is.
const UNKNOWN_HOLD_MS = 30 * 60 * 1000;
// After upstream said "nothing to do here" for this account.
const DECLINED_COOLDOWN_MS = 30 * 60 * 1000;
// The verdicts the endpoint is known to give. Anything else (no `result`, a new word) over a 2xx is no
// verdict we can read, so it is handled like a lost answer: the grant may be spent.
const KNOWN_RESULTS = new Set(['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible', 'unavailable']);
// After an account turned out to hold nothing usable.
const NOTHING_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const CLAUDE_REDEEM_BUDGET_MS = 15_000;
// The operator's single-seat spend is not racing a waiting request: room for a token refresh, a
// status read, the claim and the re-read.
export const CLAUDE_MANUAL_REDEEM_BUDGET_MS = 45_000;
// The automatic rules (reset-rules.js): at most one rule spend per seat per this long.
export const RULE_SPACING_MS = 24 * 60 * 60 * 1000;

/** @param {Record<string, any>} account */
function headers(account) {
  return {
    Authorization: `Bearer ${account.credential}`,
    'anthropic-beta': OAUTH_USAGE_BETA,
    'User-Agent': USAGE_USER_AGENT,
    Accept: 'application/json',
  };
}

/** @param {unknown} v */
const isoMs = v => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** @param {unknown} v */
const names = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 64) : []);

/**
 * The `cedar_ember` block as the redeemer reasons about it, or null when the
 * payload says nothing usable. Unlike oauth.js's `bankedResets`, this keeps the
 * grant ids: it exists to spend one.
 *
 * @param {any} block
 */
export function parseResetStatus(block) {
  if (!block || typeof block !== 'object' || typeof block.eligible !== 'boolean') return null;
  const grants = (Array.isArray(block.grants) ? block.grants : []).flatMap((/** @type {any} */ g) => {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !GRANT_ID.test(g.id)) return [];
    const left = Number(g.resets_left);
    return [{
      id: g.id,
      resetsLeft: Number.isInteger(left) && left > 0 ? left : 0,
      clears: names(g.clears),
      usableNow: g.usable_now === true,
      paused: g.paused === true,
      endsAt: isoMs(g.ends_at),
    }];
  });
  const next = typeof block.next_grant_id === 'string' && grants.some((/** @type {{ id: string }} */ g) => g.id === block.next_grant_id) ? block.next_grant_id : null;
  return {
    eligible: block.eligible,
    ineligibleReason: typeof block.ineligible_reason === 'string' ? safeLine(block.ineligible_reason, 32) : null,
    atLimit: block.at_limit === true,
    exhausted: names(block.exhausted),
    nextGrantId: next,
    cooldownUntil: isoMs(block.cooldown_until),
    grants,
  };
}

/** @typedef {NonNullable<ReturnType<typeof parseResetStatus>>} ResetStatus */

/**
 * The grant a claim would spend: only `next_grant_id`, and only while it can be
 * used. Null when there is none.
 *
 * @param {ResetStatus|null} status
 * @param {number} [now]
 */
export function claimableGrant(status, now = Date.now()) {
  if (!status?.eligible || !status.nextGrantId) return null;
  const g = status.grants.find((/** @type {{ id: string }} */ x) => x.id === status.nextGrantId);
  if (!g || g.resetsLeft < 1 || !g.usableNow || g.paused) return null;
  if (g.endsAt != null && g.endsAt <= now) return null;
  return g;
}

/**
 * Read one account's reset status (and, from the same payload, its usage — so
 * the caller can re-apply quota after a reset without a second request).
 *
 * @param {Record<string, any>} account
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 */
export async function fetchClaudeResetStatus(account, { fetchImpl = proxyFetch, timeoutMs = 10_000 } = {}) {
  if (!account?.credential) return { error: 'no credential' };
  try {
    const res = await fetchImpl(USAGE_URL, { headers: headers(account), signal: AbortSignal.timeout(timeoutMs), routing: account.routing ?? null });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const data = await res.json();
    return { reset: parseResetStatus(data?.cedar_ember), usage: normalizeUsagePayload(data) };
  } catch (/** @type {any} */ err) {
    return { error: safeLine(err?.message || String(err), 120), status: null };
  }
}

/**
 * Spend one grant. The single irreversible call in this file. `requestId` must
 * be replayed after an unread answer, never re-minted.
 *
 * @param {Record<string, any>} account
 * @param {{ grantId: string, requestId: string }} claim
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 */
export async function claimClaudeReset(account, { grantId, requestId }, { fetchImpl = proxyFetch, timeoutMs = 20_000 } = {}) {
  if (!account?.credential || !account?.orgUuid) return { error: 'missing Claude account identity' };
  if (!GRANT_ID.test(grantId) || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) return { error: 'malformed grant or request id' };
  try {
    const res = await fetchImpl(`${RESET_HOST}/api/organizations/${encodeURIComponent(account.orgUuid)}/reset_rate_limits`, {
      method: 'POST',
      headers: { ...headers(account), 'Content-Type': 'application/json' },
      body: JSON.stringify({ program: CLAUDE_RESET_PROGRAM, grant_id: grantId, request_id: requestId }),
      signal: AbortSignal.timeout(timeoutMs),
      routing: account.routing ?? null,
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const data = await res.json();
    const result = typeof data?.result === 'string' ? safeLine(data.result, 32) : null;
    const left = Number(data?.resets_left);
    return {
      result,
      reason: typeof data?.reason === 'string' ? safeLine(data.reason, 32) : null,
      resetsLeft: Number.isInteger(left) ? left : null,
      cleared: names(data?.cleared),
      cooldownUntil: isoMs(data?.cooldown_until),
    };
  } catch (/** @type {any} */ err) {
    return { error: safeLine(err?.message || String(err), 120), status: null };
  }
}

/**
 * When this account would come back on its own: the latest reset among the
 * windows it has spent. The pool-dry walk spends on the account that would wait
 * longest, since a reset there buys the most.
 *
 * @param {Record<string, any>} account
 * @param {number} now
 */
export function blockedUntil(account, now = Date.now()) {
  const q = account?.quota || {};
  let until = 0;
  for (const [use, reset] of [['unified5h', 'unified5hReset'], ['unified7d', 'unified7dReset'], ['unified7dFable', 'unified7dFableReset'], ['unified7dSonnet', 'unified7dSonnetReset']]) {
    if (q[use] != null && q[use] >= 0.98 && q[reset] > now) until = Math.max(until, q[reset]);
  }
  return until;
}

/** The all-models weekly use (0..1) a normalized usage payload measured, or null. @param {any} usage */
function weeklyOf(usage) {
  const u = usage && !usage.error ? usage.sevenDay?.utilization : null;
  return typeof u === 'number' && Number.isFinite(u) ? u : null;
}

/** The 5-hour use (0..1) a normalized usage payload measured, or null. @param {any} usage */
function fiveHourOf(usage) {
  const u = usage && !usage.error ? usage.fiveHour?.utilization : null;
  return typeof u === 'number' && Number.isFinite(u) ? u : null;
}

/** @typedef {{ redeemed: boolean, reason: string, account?: string, result?: string|null, resetsLeft?: number|null, cleared?: string[], maybeSpent?: boolean }} ClaudeRedeemResult */

export class ClaudeResetRedeemer {
  /**
   * @param {any} accountManager
   * @param {{ config?: Record<string, any>|null, statusFn?: Function, claimFn?: Function, now?: () => number, log?: Function, timeoutMs?: number, persist?: () => Promise<unknown> }} [opts]
   */
  constructor(accountManager, { config = null, statusFn = fetchClaudeResetStatus, claimFn = claimClaudeReset, now = Date.now, log = console.log, timeoutMs = CLAUDE_REDEEM_BUDGET_MS, persist = async () => {} } = {}) {
    this.am = accountManager;
    // Writes the saved quota state now (a rule's 24 h reservation must be on disk before its claim).
    this.persist = persist;
    this.config = config;
    this.statusFn = statusFn;
    this.claimFn = claimFn;
    this.now = now;
    this.log = log;
    this.timeoutMs = timeoutMs;
    /** @type {WeakMap<object, { cooldownUntil: number, requestId: string|null, grantId: string|null }>} */
    this.state = new WeakMap();
    /** @type {Promise<ClaudeRedeemResult>|null} */
    this.inFlight = null;
  }

  /**
   * The fleet hold: armed by a reset that landed or may have, it stops the next
   * refusal — and the rest of this one's walk — spending a sibling's reset on
   * top of it. Kept on the accounts' saved quota (`claudeResetHoldUntil`), so a
   * restart minutes after a claim that may have landed does not spend another;
   * the latest any account carries holds them all.
   */
  get fleetHoldUntil() {
    let until = 0;
    for (const account of this.am.accounts || []) {
      const held = account.quota?.claudeResetHoldUntil;
      if (Number.isFinite(held)) until = Math.max(until, held);
    }
    return until;
  }

  /**
   * @param {Record<string, any>} account
   * @param {number} until
   */
  _holdFleet(account, until) {
    const held = account.quota.claudeResetHoldUntil;
    account.quota.claudeResetHoldUntil = Number.isFinite(held) ? Math.max(held, until) : until;
  }

  /** @param {object} account */
  _stateFor(account) {
    let s = this.state.get(account);
    if (!s) { s = { cooldownUntil: 0, requestId: null, grantId: null }; this.state.set(account, s); }
    return s;
  }

  /** @param {Record<string, any>} account */
  _isClaude(account) {
    return !!account && providerOf(account) === DEFAULT_PROVIDER && !account.upstream && account.type === 'oauth';
  }

  /**
   * The pool-dry entry point: every Claude account this request could use is
   * out, so maybe spend ONE reset on one of `accounts`. Armed by the same fleet
   * switch as the Codex redeemer (`autoRedeemResets`), read off the shared
   * config per refusal so a toggle applies at once.
   *
   * @param {Record<string, any>[]} accounts
   * @returns {Promise<ClaudeRedeemResult>}
   */
  async maybeRedeemForPool(accounts) {
    if (this.config?.autoRedeemResets !== true) return { redeemed: false, reason: 'auto-redeem is switched off' };
    if (!accounts?.length) return { redeemed: false, reason: 'no candidate accounts' };
    if (this.inFlight) return this.inFlight;
    const attempt = this._attempt(accounts).finally(() => { this.inFlight = null; });
    this.inFlight = attempt;
    return attempt;
  }

  /** @param {Record<string, any>[]} accounts */
  async _attempt(accounts) {
    const now = this.now();
    if (now < this.fleetHoldUntil) return { redeemed: false, reason: 'holding off after a recent Claude reset attempt' };
    const deadline = now + this.timeoutMs;
    const candidates = accounts
      .filter(a => this._isClaude(a) && a.orgUuid && !a.disabled && a.autoRedeemReset !== false)
      .filter(a => a.quota?.resetCredits?.available !== 0)
      .filter(a => now >= this._stateFor(a).cooldownUntil)
      .sort((a, b) => blockedUntil(b, now) - blockedUntil(a, now));
    let reason = 'no Claude account holds a usable reset';
    for (const account of candidates) {
      if (this.now() >= deadline) { reason = 'ran out of the redeem budget'; break; }
      const r = await this._redeem(account, deadline, { auto: true });
      if (r.redeemed) return r;
      reason = r.reason;
      if (this.now() < this.fleetHoldUntil) break;
    }
    return { redeemed: false, reason };
  }

  /**
   * The one account `seat` names: its full name, or the part before the `@` when exactly one account
   * has it. Null when nothing (or more than one account) matches, so a typo never lands on a sibling.
   *
   * @param {string} seat
   */
  _seatNamed(seat) {
    const all = this.am.accounts || [];
    const exact = all.filter((/** @type {any} */ a) => a.name === seat);
    if (exact.length) return exact.length === 1 ? exact[0] : null;
    const local = all.filter((/** @type {any} */ a) => typeof a.name === 'string' && a.name.split('@')[0] === seat);
    return local.length === 1 ? local[0] : null;
  }

  /**
   * The operator's single-seat spend (`teamclaude resets redeem <seat>`): exactly the named seat, never
   * a sibling. Not gated by `autoRedeemResets` or the per-account exemption, which govern the
   * AUTOMATIC spend; the operator's command is the decision here. Everything else holds: a Claude OAuth
   * seat with an org id, not disabled, the fleet hold after a recent attempt, one attempt in flight at a
   * time, and every check of the pool-dry path (at a weekly limit that its reset clears, no upstream
   * cooldown, only `next_grant_id`, the request id replayed after an unread answer). `dryRun` runs every
   * check, reads the seat's status (zero spend) and stops before the claim, leaving no cooldown behind.
   *
   * @param {unknown} seat
   * @param {{ dryRun?: boolean }} [opts]
   * @returns {Promise<ClaudeRedeemResult & { wouldRedeem?: boolean, weeklyBefore?: number|null, weeklyAfter?: number|null }>}
   */
  async redeemNamed(seat, { dryRun = false } = {}) {
    if (typeof seat !== 'string' || !seat || seat.length > 128) return { redeemed: false, reason: 'no seat named' };
    const account = this._seatNamed(seat);
    if (!account) return { redeemed: false, reason: 'no single seat by that name' };
    const name = safeLine(account.name, 64);
    if (!this._isClaude(account) || !account.orgUuid) return { redeemed: false, account: name, reason: 'not a Claude subscription seat' };
    if (account.disabled) return { redeemed: false, account: name, reason: 'the seat is disabled' };
    if (this.inFlight) return { redeemed: false, account: name, reason: 'another reset attempt is in flight' };
    const now = this.now();
    if (now < this.fleetHoldUntil) return { redeemed: false, account: name, reason: 'holding off after a recent Claude reset attempt' };
    const state = this._stateFor(account);
    const savedCooldown = state.cooldownUntil;
    // Measured, never cached: before = the status read just ahead of the claim, after = the re-read once
    // it landed. Either stays null when that read did not happen or failed.
    const observe = { weeklyBefore: /** @type {number|null} */ (null), weeklyAfter: /** @type {number|null} */ (null) };
    const attempt = this._redeem(account, now + CLAUDE_MANUAL_REDEEM_BUDGET_MS, { why: 'the operator asked for this seat', dryRun, observe })
      .then(r => {
        if (dryRun) state.cooldownUntil = savedCooldown;
        return { ...r, weeklyBefore: observe.weeklyBefore, weeklyAfter: observe.weeklyAfter };
      })
      .finally(() => { this.inFlight = null; });
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * One of the automatic rules (reset-rules.js) chose this seat: spend its next grant if a LIVE read
   * still agrees. Armed by the same fleet switch as the pool-dry spend; at most one rule spend per seat
   * per RULE_SPACING_MS (kept on the seat's saved quota, `claudeResetRuleAt`, so a restart does not
   * lift it); the fleet hold, the in-flight lock and the per-seat cooldown all apply, so a stale
   * reading costs at most one status read per cooldown.
   *
   * @param {Record<string, any>} account
   * @param {'expiry'|'five-hour'} rule
   * @param {string} [why]
   * @param {{ pool5h?: () => number|null }} [opts] the pool's 5-hour remaining, re-read just before a
   *   'five-hour' claim (the fleet may have recovered during the live status read)
   * @returns {Promise<ClaudeRedeemResult & { rule?: string, grantId?: string|null, weeklyBefore?: number|null, weeklyAfter?: number|null, fiveHourBefore?: number|null, fiveHourAfter?: number|null }>}
   */
  async redeemByRule(account, rule, why = '', { pool5h = () => null } = {}) {
    const name = safeLine(account?.name, 64);
    if (this.config?.autoRedeemResets !== true) return { redeemed: false, account: name, reason: 'auto-redeem is switched off' };
    if (rule !== 'expiry' && rule !== 'five-hour') return { redeemed: false, account: name, reason: 'unknown rule' };
    if (!this._isClaude(account) || !account.orgUuid || account.disabled || account.autoRedeemReset === false) return { redeemed: false, account: name, reason: 'not a seat the rules may spend on' };
    if (this.inFlight) return { redeemed: false, account: name, reason: 'another reset attempt is in flight' };
    const now = this.now();
    if (now < this.fleetHoldUntil) return { redeemed: false, account: name, reason: 'holding off after a recent Claude reset attempt' };
    const last = account.quota?.claudeResetRuleAt;
    if (Number.isFinite(last) && now - last < RULE_SPACING_MS) return { redeemed: false, account: name, reason: 'a rule already spent on this seat in the last 24 h' };
    const state = this._stateFor(account);
    if (now < state.cooldownUntil) return { redeemed: false, account: name, reason: 'cooling down after a recent check' };
    const observe = { weeklyBefore: /** @type {number|null} */ (null), weeklyAfter: /** @type {number|null} */ (null), fiveHourBefore: /** @type {number|null} */ (null), fiveHourAfter: /** @type {number|null} */ (null), grantId: /** @type {string|null} */ (null) };
    const attempt = this._redeem(account, now + CLAUDE_MANUAL_REDEEM_BUDGET_MS, { why: `rule ${rule}${why ? `: ${why}` : ''}`, rule, observe, auto: true, pool5h })
      .then(r => ({ ...r, rule, ...observe }))
      .finally(() => { this.inFlight = null; });
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * @param {Record<string, any>} account
   * @param {number} deadline
   * @param {{ why?: string, dryRun?: boolean, rule?: 'expiry'|'five-hour'|null, auto?: boolean, pool5h?: () => number|null, observe?: { weeklyBefore: number|null, weeklyAfter: number|null, fiveHourBefore?: number|null, fiveHourAfter?: number|null, grantId?: string|null }|null }} [opts]
   * @returns {Promise<ClaudeRedeemResult & { wouldRedeem?: boolean }>}
   */
  async _redeem(account, deadline, { why = 'no Claude account can serve the request', dryRun = false, rule = null, auto = false, pool5h = () => null, observe = null } = {}) {
    const name = safeLine(account.name, 64);
    const state = this._stateFor(account);
    const now = this.now();
    try { await this.am.ensureTokenFresh(account.index); } catch (/** @type {any} */ err) {
      state.cooldownUntil = now + DECLINED_COOLDOWN_MS; // never a refresh per response
      return { redeemed: false, account: name, reason: `token refresh failed (${safeLine(err?.message || String(err), 80)})` };
    }
    const left = () => Math.max(1, deadline - this.now());
    const read = await this.statusFn(account, { timeoutMs: left() });
    if (read?.error) {
      state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
      return { redeemed: false, account: name, reason: `could not read reset status (${read.error})` };
    }
    if (observe) { observe.weeklyBefore = weeklyOf(read.usage); observe.fiveHourBefore = fiveHourOf(read.usage); }
    const status = read.reset;
    if (!status || !status.eligible) {
      state.cooldownUntil = now + NOTHING_COOLDOWN_MS;
      return { redeemed: false, account: name, reason: `not eligible for resets${status?.ineligibleReason ? ` (${status.ineligibleReason})` : ''}` };
    }
    // An earlier claim on this seat got no readable answer: replay THAT grant with THAT request id while
    // upstream still lists it, rather than letting a fresh `next_grant_id` mint a second spend. Upstream
    // answers `already_used` if it landed, spends it now if it did not, or declines (nothing spent).
    const pending = state.requestId && state.grantId ? status.grants.find((/** @type {{ id: string }} */ g) => g.id === state.grantId) : null;
    if (state.requestId && state.grantId && !pending) {
      state.cooldownUntil = now + UNKNOWN_HOLD_MS; // fail closed without a status read per request
      // Its grant is gone from the list: most likely that claim spent it. Fail closed: never mint a
      // second spend on top of an unresolved one. Kept in memory, so a restart clears it.
      return { redeemed: false, maybeSpent: true, account: name, reason: 'an earlier reset on this seat got no verdict and its grant is no longer listed, so it most likely went through; nothing more is spent until the proxy restarts' };
    }
    const grant = pending || claimableGrant(status, now);
    if (!grant) {
      state.cooldownUntil = now + NOTHING_COOLDOWN_MS;
      return { redeemed: false, account: name, reason: 'holds no usable reset' };
    }
    const liveWeekly = weeklyOf(read.usage);
    if (rule === 'expiry') {
      // A weekly-clearing reset that would expire before the seat's own week resets: spend it at >= 60 %
      // weekly (live), never on a seat whose week resets first.
      // the LIVE week reset, never the cached one: a stale cache could spend a grant the week outlives
      const liveReset = read.usage?.sevenDay?.resetAt;
      const weekReset = typeof liveReset === 'number' && Number.isFinite(liveReset) ? liveReset : null;
      const no = !grant.clears.includes('seven_day') ? 'its next reset does not clear the weekly'
        : grant.endsAt == null || weekReset == null || !(grant.endsAt < weekReset) ? 'its reset does not expire before the seat\'s week resets'
          : liveWeekly == null || liveWeekly < 0.6 ? 'weekly use is under 60%' : null;
      if (no) { state.cooldownUntil = now + DECLINED_COOLDOWN_MS; return { redeemed: false, account: name, reason: no }; }
    } else if (rule === 'five-hour') {
      // Only at a live 5-hour wall with weekly room, and never with a reset that would clear the weekly.
      const no = grant.clears.includes('seven_day') ? 'its next reset clears the weekly; kept for a weekly wall'
        : !grant.clears.includes('five_hour') ? 'its next reset does not clear the 5-hour window'
          : !status.exhausted.includes('five_hour') ? 'not at its 5-hour wall'
            : status.exhausted.some((/** @type {string} */ l) => l.startsWith('seven_day')) || liveWeekly == null || liveWeekly >= 0.7 ? 'its week has no room'
              : null;
      if (no) { state.cooldownUntil = now + DECLINED_COOLDOWN_MS; return { redeemed: false, account: name, reason: no }; }
    } else {
      if (!status.atLimit || !status.exhausted.length) {
        state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
        return { redeemed: false, account: name, reason: 'not at a usage limit' };
      }
      // A grant is scarce and a 5-hour wall lifts on its own within hours: spend
      // one only where a weekly limit (the all-models week or a family's,
      // `seven_day*`) is what turns the account away.
      if (!status.exhausted.some((/** @type {string} */ limit) => limit.startsWith('seven_day'))) {
        state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
        return { redeemed: false, account: name, reason: 'no weekly limit is exhausted' };
      }
      // Spent on an account it would not return to service, a reset buys this
      // request nothing — and the grant is gone.
      const uncovered = status.exhausted.filter((/** @type {string} */ limit) => !grant.clears.includes(limit));
      if (uncovered.length) {
        state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
        return { redeemed: false, account: name, reason: `its reset does not clear ${uncovered.join(', ')}` };
      }
    }
    // Upstream already says a claim now would answer `cooldown`: save the POST.
    if (status.cooldownUntil != null && status.cooldownUntil > now) {
      state.cooldownUntil = status.cooldownUntil;
      return { redeemed: false, account: name, reason: 'upstream reports a reset cooldown' };
    }
    if (dryRun) {
      return { redeemed: false, wouldRedeem: true, account: name, reason: `would redeem: at ${status.exhausted.join(', ')}, its reset clears ${grant.clears.join(', ')}`, resetsLeft: grant.resetsLeft, cleared: grant.clears };
    }
    if (state.grantId !== grant.id) { state.grantId = grant.id; state.requestId = null; }
    if (observe) observe.grantId = grant.id;
    // A rule's 24 h reservation goes on disk BEFORE the irreversible claim: a restart between the claim
    // and its answer must not allow a second rule spend on this seat within the day. It records the
    // attempt's deadline, which is never earlier than the claim, so two spends are >= 24 h apart.
    // The fleet hold goes on disk with it (a crash after the claim must not free a sibling to spend on
    // top of it); a definite refusal or decline gives both back.
    const prevRuleAt = account.quota.claudeResetRuleAt;
    const prevHold = account.quota.claudeResetHoldUntil;
    if (rule) {
      account.quota.claudeResetRuleAt = deadline;
      this._holdFleet(account, now + UNKNOWN_HOLD_MS);
      try { await this.persist(); } catch {
        account.quota.claudeResetRuleAt = prevRuleAt;
        account.quota.claudeResetHoldUntil = prevHold;
        state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
        return { redeemed: false, account: name, reason: 'could not save the rule reservation; nothing spent' };
      }
    }
    // Automatic paths re-check, right before the claim, what may have changed while refreshing, reading
    // and saving; a refusal here gives the reservation back.
    // The released reservation is written too: a restart must not bring back a day nothing was spent on.
    const release = async () => {
      if (!rule) return;
      account.quota.claudeResetRuleAt = prevRuleAt;
      account.quota.claudeResetHoldUntil = prevHold;
      try { await this.persist(); } catch { /* the next periodic save writes it */ }
    };
    const refuse = async (/** @type {string} */ reason) => {
      await release();
      state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
      return { redeemed: false, account: name, reason };
    };
    if (auto && this.config?.autoRedeemResets !== true) return refuse('auto-redeem is switched off');
    if (auto && (account.disabled || account.autoRedeemReset === false)) return refuse('the seat was disabled or exempted');
    if (rule === 'five-hour') {
      const pool = pool5h();
      if (pool == null || !(pool < 0.2)) return refuse('the pool\'s 5-hour headroom recovered');
    }
    // The reservation covers the claim only while the attempt is inside its deadline.
    if (rule && this.now() >= deadline) return refuse('ran out of time before the claim');
    state.requestId ||= randomUUID();
    this.log(`[TeamClaude] Redeeming a banked Claude usage-limit reset on "${name}" (grant ${grant.id}) — ${why}`);
    const r = await this.claimFn(account, { grantId: grant.id, requestId: state.requestId }, { timeoutMs: left() });

    if (r?.error || !KNOWN_RESULTS.has(r?.result)) {
      // No verdict, over a POST that may have spent the grant: keep the key for
      // a replay, and stop anything else spending in the meantime.
      const why = r?.error || `unreadable answer (${r?.result ?? 'no result'})`;
      state.cooldownUntil = now + UNKNOWN_HOLD_MS;
      this._holdFleet(account, now + UNKNOWN_HOLD_MS);
      this.log(`[TeamClaude] Claude reset on "${name}" (grant ${grant.id}) got no verdict (${why}); it may have been spent, so the fleet holds off`);
      return { redeemed: false, maybeSpent: true, account: name, reason: `reset request got no verdict (${why}); it may still have gone through` };
    }
    state.requestId = null;
    state.grantId = null;
    if (r.result === 'reset' || r.result === 'already_used') {
      state.cooldownUntil = now + SUCCESS_HOLD_MS;
      this._holdFleet(account, now + SUCCESS_HOLD_MS);
      this.log(`[TeamClaude] Redeemed a Claude usage-limit reset on "${name}" (grant ${grant.id}) — cleared ${(r.cleared || []).join(', ') || 'its limits'}, ${r.resetsLeft ?? '?'} left`);
      const after = await this._reapply(account, deadline);
      if (observe) { observe.weeklyAfter = after.weekly; observe.fiveHourAfter = after.fiveHour; }
      return { redeemed: true, account: name, reason: why, result: r.result, resetsLeft: r.resetsLeft, cleared: r.cleared };
    }
    state.cooldownUntil = r.result === 'cooldown' && r.cooldownUntil ? r.cooldownUntil : now + DECLINED_COOLDOWN_MS;
    await release(); // upstream declined: nothing spent, the day is not used
    this.log(`[TeamClaude] Claude reset on "${name}" declined upstream (${r.result || 'no result'}${r.reason ? `: ${r.reason}` : ''}); nothing was spent`);
    return { redeemed: false, account: name, reason: `upstream declined (${r.result || 'no result'}${r.reason ? `: ${r.reason}` : ''})`, result: r.result };
  }

  /**
   * Put the account back in service: drop any hold and any stored upstream
   * `rejected` verdict (a quota re-read does not touch it, so the account would
   * otherwise read `upstream-rejected` until it went stale), then re-read its
   * quota. Never fabricates a reading; if the read fails, traffic re-learns it.
   *
   * @param {Record<string, any>} account
   * @param {number} deadline
   * @returns {Promise<{ weekly: number|null, fiveHour: number|null }>} what the re-read measured; null when it failed
   */
  async _reapply(account, deadline) {
    try { this.am.clearRateLimited(account.index); } catch { /* not held */ }
    try { this.am.clearUpstreamRejected(account.index); } catch { /* not rejected */ }
    const read = await this.statusFn(account, { timeoutMs: Math.max(1, deadline - this.now()) });
    if (!read?.usage || read.usage.error) return { weekly: null, fiveHour: null };
    this.am.applyUsageData(account.index, read.usage);
    return { weekly: weeklyOf(read.usage), fiveHour: fiveHourOf(read.usage) };
  }
}
