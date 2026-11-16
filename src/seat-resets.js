// Per-seat view for the plan's Seats tile and `teamclaude resets` (JP, plan-chat 2026-11-15 22:59: "show
// how many quota resets each account has left and a way of triggering them intelligently when needed").
//
//  - Banked usage-limit resets (Anthropic's `cedar_ember` grants): read with the zero-spend usage request
//    claude-resets.js already makes. Grant ids are dropped on arrival (an id is the handle that spends a
//    reset); what is kept per grant is its count, what it clears, whether it is usable, and its expiry,
//    so every view re-checks expiry against the time it is built.
//  - Windows left this week: how many more 5-hour windows a seat's weekly remaining covers at its own
//    measured burn per window, from a small ledger of window starts (weekly use and the week's reset time
//    at each start; the difference to the next start IN THE SAME WEEK is what that window burned). No
//    measured window yet → null, basis "measuring": never a guess.
//  - A dry-run verdict of the opt-in redeem rule. Nothing here spends: the one irreversible call
//    (the grant claim in claude-resets.js) is not imported, and the live redeemer stays behind
//    autoRedeemResets.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fetchClaudeResetStatus } from './claude-resets.js';
import { providerOf } from './provider.js';

const WEEK_MS = 7 * 24 * 3600_000;
const HOUR_MS = 3600_000;
/** Two readings of a week's reset time this close together name the same week. */
const SAME_WEEK_MS = HOUR_MS;
/** A probe of every seat costs one usage request each; asking again within this window reuses it. */
export const PROBE_MIN_INTERVAL_MS = 10 * 60_000;

/**
 * @typedef {{ id: string, resetsLeft: number, clears: string[], usableNow: boolean, paused: boolean, endsAt: number|null }} Grant
 * @typedef {{ eligible: boolean, ineligibleReason: string|null, atLimit: boolean, exhausted: string[], nextGrantId: string|null, cooldownUntil: number|null, grants: Grant[] }} ResetStatus
 * @typedef {{ resetsLeft: number, clearsWeekly: boolean, clears: string[], usable: boolean, endsAt: number|null }} KeptGrant
 * @typedef {{ eligible: boolean, ineligibleReason: string|null, atLimit: boolean, cooldownUntil: number|null, grants: KeptGrant[] }} KeptStatus
 * @typedef {{ eligible: boolean, ineligibleReason: string|null, available: number, applicable: number, expiresAt: number|null, weeklyApplicable: number, weeklyExpiresAt: number|null, atLimit: boolean, cooldownUntil: number|null, clears: string[] }} ResetSummary
 * @typedef {{ start: number, weeklyAtStart: number|null, weekResetAt?: number|null, burn?: number|null }} WindowRecord
 */

/**
 * The status as kept: no grant id, nothing that could spend. Each grant keeps its own count, scope,
 * usability and expiry, so a summary never combines one grant's usability with another's scope.
 * @param {ResetStatus|null|undefined} status
 * @returns {KeptStatus|null}
 */
export function keepStatus(status) {
  if (!status) return null;
  return {
    eligible: status.eligible,
    ineligibleReason: status.ineligibleReason,
    atLimit: status.atLimit,
    cooldownUntil: status.cooldownUntil,
    grants: status.grants.map((g) => ({
      resetsLeft: g.resetsLeft,
      clearsWeekly: g.clears.includes('seven_day'),
      clears: [...g.clears].sort(),
      usable: g.usableNow && !g.paused,
      endsAt: g.endsAt,
    })),
  };
}

/**
 * What a person (or the plan) may see, computed at `now` (an expired grant counts for nothing).
 * `applicable` = usable now; `weeklyApplicable` = usable now AND clears the weekly, with its own soonest
 * expiry. Accepts a full status too (its ids are not read).
 * @param {KeptStatus|ResetStatus|null|undefined} status
 * @param {number} now
 * @returns {ResetSummary|null}
 */
export function resetSummary(status, now) {
  if (!status) return null;
  const kept = /** @type {KeptStatus} */ ('id' in (status.grants[0] || {}) ? keepStatus(/** @type {ResetStatus} */ (status)) : status);
  let available = 0;
  let applicable = 0;
  let weeklyApplicable = 0;
  /** @type {number|null} */
  let expiresAt = null;
  /** @type {number|null} */
  let weeklyExpiresAt = null;
  /** @type {Set<string>} */
  const clears = new Set();
  for (const g of kept.grants) {
    if (g.resetsLeft < 1) continue;
    if (g.endsAt != null && g.endsAt <= now) continue;
    available += g.resetsLeft;
    if (g.endsAt != null && (expiresAt == null || g.endsAt < expiresAt)) expiresAt = g.endsAt;
    for (const c of g.clears) clears.add(c);
    if (!g.usable) continue;
    applicable += g.resetsLeft;
    if (!g.clearsWeekly) continue;
    weeklyApplicable += g.resetsLeft;
    if (g.endsAt != null && (weeklyExpiresAt == null || g.endsAt < weeklyExpiresAt)) weeklyExpiresAt = g.endsAt;
  }
  return {
    eligible: kept.eligible,
    ineligibleReason: kept.ineligibleReason,
    available,
    applicable,
    expiresAt,
    weeklyApplicable,
    weeklyExpiresAt,
    atLimit: kept.atLimit,
    cooldownUntil: kept.cooldownUntil,
    clears: [...clears].sort(),
  };
}

/** Median of a non-empty list. @param {number[]} xs */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** @param {unknown} v @returns {number|null} */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A time Date can represent (ms epoch), else null. @param {unknown} v @returns {number|null} */
const time = (v) => (typeof v === 'number' && Number.isFinite(v) && !Number.isNaN(new Date(v).getTime()) ? v : null);

/**
 * Window starts per seat, kept 7 days, persisted beside the config (`<config>-windows.json`, 0600).
 * A window's burn is the weekly utilisation gained between its start and the next start, but only when
 * both starts name the same week (the week's reset time, within an hour); across a week reset, or
 * when either reading is missing, the burn is unknown (null), never a number.
 */
export class WindowLedger {
  /** @param {{ statePath?: string|null, now?: () => number, log?: (line: string) => void }} [opts] */
  constructor({ statePath = null, now = Date.now, log = (l) => console.log(l) } = {}) {
    this.statePath = statePath;
    this.now = now;
    this.log = log;
    /** @type {Record<string, WindowRecord[]>} */
    this.seats = Object.create(null);
    this._load();
  }

  _load() {
    if (!this.statePath) return;
    let raw;
    try { raw = JSON.parse(readFileSync(this.statePath, 'utf8')); } catch { return; }
    if (!raw || typeof raw !== 'object' || !raw.seats || typeof raw.seats !== 'object') return;
    const now = this.now();
    for (const [name, list] of Object.entries(raw.seats)) {
      if (!Array.isArray(list)) continue;
      const ok = list.filter((/** @type {any} */ r) => r && Number.isFinite(r.start) && now - r.start < WEEK_MS
        && (r.weeklyAtStart === null || Number.isFinite(r.weeklyAtStart))
        && (r.weekResetAt === undefined || r.weekResetAt === null || Number.isFinite(r.weekResetAt))
        && (r.burn === undefined || r.burn === null || Number.isFinite(r.burn)));
      if (ok.length) this.seats[name] = ok;
    }
  }

  _save() {
    if (!this.statePath) return;
    try {
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ seats: this.seats }) + '\n', { mode: 0o600 });
      renameSync(tmp, this.statePath);
    } catch (err) {
      this.log(`[TeamClaude] Seat windows: could not save the ledger: ${/** @type {any} */ (err)?.message || err}`);
    }
  }

  /**
   * A seat started a 5-hour window; `weekly` is its weekly utilisation now (0..1) and `weekResetAt` the
   * time its current week resets (ms), either possibly unknown.
   * @param {string} name
   * @param {number|null|undefined} weekly
   * @param {number|null|undefined} [weekResetAt]
   */
  record(name, weekly, weekResetAt) {
    const now = this.now();
    const w = num(weekly);
    const reset = num(weekResetAt);
    const list = Object.hasOwn(this.seats, name) && Array.isArray(this.seats[name]) ? this.seats[name] : (this.seats[name] = []);
    const prev = list[list.length - 1];
    if (prev && prev.burn === undefined) {
      const sameWeek = reset != null && prev.weekResetAt != null && Math.abs(reset - prev.weekResetAt) <= SAME_WEEK_MS;
      const d = sameWeek && w != null && prev.weeklyAtStart != null ? w - prev.weeklyAtStart : null;
      prev.burn = d != null && d >= 0 ? d : null;
    }
    list.push({ start: now, weeklyAtStart: w, weekResetAt: reset });
    this.seats[name] = list.filter((r) => now - r.start < WEEK_MS);
    this._save();
  }

  /**
   * The seat's measured burn per window: the median of its closed windows in the last 7 days that burned
   * anything (age is checked here too, so an idle seat's old windows stop counting without a new start).
   * @param {string} name
   * @returns {{ burn: number|null, windows: number }}
   */
  burn(name) {
    const now = this.now();
    const burns = (Object.hasOwn(this.seats, name) && Array.isArray(this.seats[name]) ? this.seats[name] : [])
      .filter((r) => now - r.start < WEEK_MS)
      .map((r) => r.burn)
      .filter((b) => typeof b === 'number' && b > 0.0005);
    return burns.length ? { burn: median(/** @type {number[]} */ (burns)), windows: burns.length } : { burn: null, windows: 0 };
  }
}

/**
 * How many more 5-hour windows this seat's weekly remaining covers at its measured burn.
 * @param {number|null|undefined} weeklyUsed  0..1
 * @param {{ burn: number|null, windows: number }} measured
 * @returns {{ windowsLeft: number|null, basis: string }}
 */
export function windowsLeft(weeklyUsed, measured) {
  if (typeof weeklyUsed !== 'number' || !Number.isFinite(weeklyUsed)) return { windowsLeft: null, basis: 'weekly use unknown' };
  if (measured.burn == null) return { windowsLeft: null, basis: 'measuring' };
  const left = Math.max(0, 1 - weeklyUsed);
  return { windowsLeft: Math.floor(left / measured.burn + 1e-9), basis: `median burn ${(measured.burn * 100).toFixed(1)}% over ${measured.windows} window${measured.windows === 1 ? '' : 's'}` };
}

/**
 * The opt-in redeem rule, as a verdict only. A spent seat's reset is worth spending when ALL hold: it
 * holds a reset usable now that clears the weekly; the pool's weekly remaining is under `poolBelow`; this
 * seat's own weekly is spent; no other seat has weekly room; and its own weekly reset is KNOWN to be more
 * than `minHoursToReset` away (never burn a reset on a week about to reset anyway). A weekly reset that
 * would expire before the seat's natural reset is worth spending even with less time left (otherwise it
 * is lost). Anything unknown is a "no", never a "yes".
 * @param {{ name: string, weeklyUsed: number|null, weeklyResetAt: number|null, resets: ResetSummary|null }} seat
 * @param {{ poolWeeklyRemaining: number|null, othersWithRoom: number, othersUnknown?: number }} pool
 * @param {{ now: number, poolBelow?: number, minHoursToReset?: number, spentAt?: number }} opts
 * @returns {{ would: boolean, reason: string }}
 */
export function redeemVerdict(seat, pool, { now, poolBelow = 0.05, minHoursToReset = 24, spentAt = 0.98 }) {
  const r = seat.resets;
  if (!r) return { would: false, reason: 'reset status not read' };
  if (!r.eligible) return { would: false, reason: `not eligible${r.ineligibleReason ? ` (${r.ineligibleReason})` : ''}` };
  if (r.available < 1) return { would: false, reason: 'holds no reset' };
  if (r.weeklyApplicable < 1) return { would: false, reason: r.applicable > 0 ? 'no usable reset clears the weekly' : 'holds a reset, none usable now' };
  if (r.cooldownUntil != null && r.cooldownUntil > now) return { would: false, reason: 'upstream reset cooldown' };
  if (seat.weeklyUsed == null || seat.weeklyUsed < spentAt) return { would: false, reason: 'its weekly is not spent' };
  if ((pool.othersUnknown ?? 0) > 0) return { would: false, reason: `${pool.othersUnknown} other seat${pool.othersUnknown === 1 ? "'s" : "s'"} weekly use unknown` };
  if (pool.othersWithRoom > 0) return { would: false, reason: `${pool.othersWithRoom} other seat${pool.othersWithRoom === 1 ? ' has' : 's have'} weekly room` };
  if (pool.poolWeeklyRemaining == null || pool.poolWeeklyRemaining >= poolBelow) {
    return { would: false, reason: `pool weekly ${pool.poolWeeklyRemaining == null ? 'unknown' : `${Math.round(pool.poolWeeklyRemaining * 100)}%`} is not under ${Math.round(poolBelow * 100)}%` };
  }
  if (seat.weeklyResetAt == null) return { would: false, reason: 'its weekly reset time is unknown' };
  const hoursToReset = (seat.weeklyResetAt - now) / HOUR_MS;
  const expiresFirst = r.weeklyExpiresAt != null && r.weeklyExpiresAt < seat.weeklyResetAt;
  if (hoursToReset <= minHoursToReset && !expiresFirst) {
    return { would: false, reason: `its weekly resets by itself in ${hoursToReset.toFixed(1)} h` };
  }
  return { would: true, reason: expiresFirst ? 'pool nearly dry and the reset would expire before the week resets' : 'pool nearly dry, seat spent, its week far from resetting' };
}

/**
 * A failure as a fixed category: upstream or exception text never reaches a response or a log line
 * from here (it could carry a header value, a URL or an id).
 * @param {unknown} e
 */
function errorCategory(e) {
  const s = String(/** @type {any} */ (e)?.error ?? /** @type {any} */ (e)?.message ?? e ?? '');
  const http = /^HTTP (\d{3})\b/.exec(s);
  if (http) return `http ${http[1]}`;
  if (/timeout|timed out|aborted/i.test(s)) return 'timeout';
  if (/no credential/i.test(s)) return 'no credential';
  if (/ENOTFOUND|ECONN|EAI_AGAIN|socket|network|fetch failed/i.test(s)) return 'network';
  return 'read failed';
}

/**
 * Probes the banked-reset status of every Claude OAuth seat (one zero-spend usage request each), at
 * most once per PROBE_MIN_INTERVAL_MS unless forced. Keeps the id-free status and when it was last READ
 * (okAt) apart from when it was last TRIED (triedAt, with the error category of that try).
 */
export class ResetsProbe {
  /**
   * @param {{ accounts: () => Record<string, any>[], fetchStatus?: Function, applyUsage?: (account: Record<string, any>, usage: any) => void, now?: () => number }} opts
   */
  constructor({ accounts, fetchStatus = fetchClaudeResetStatus, applyUsage = () => {}, now = Date.now }) {
    this.accounts = accounts;
    this.fetchStatus = fetchStatus;
    this.applyUsage = applyUsage;
    this.now = now;
    /** @type {Map<string, { kept: KeptStatus|null, okAt: number|null, triedAt: number, error: string|null }>} */
    this.byName = new Map();
    this.lastProbeAt = 0;
    /** @type {Promise<void>|null} */
    this.inFlight = null;
  }

  /** @param {{ force?: boolean }} [opts] */
  async probe({ force = false } = {}) {
    if (this.inFlight) return this.inFlight;
    if (!force && this.now() - this.lastProbeAt < PROBE_MIN_INTERVAL_MS) return;
    this.inFlight = (async () => {
      try {
        for (const account of this.accounts()) {
          if (!isClaudeOAuth(account)) continue;
          const before = this.byName.get(account.name);
          const fail = (/** @type {unknown} */ e) => this.byName.set(account.name, { kept: before?.kept ?? null, okAt: before?.okAt ?? null, triedAt: this.now(), error: errorCategory(e) });
          try {
            const read = await this.fetchStatus(account);
            if (!read || read.error) { fail(read?.error ?? 'read failed'); continue; }
            const at = this.now();
            this.byName.set(account.name, { kept: keepStatus(read.reset ?? null), okAt: at, triedAt: at, error: read.reset ? null : 'no reset block' });
            if (read.usage && !read.usage.error) {
              try { this.applyUsage(account, read.usage); } catch { /* the reset reading stands without it */ }
            }
          } catch (e) {
            fail(e); // a malformed reading is a failed read of this seat, not an escape past the cooldown
          }
        }
      } finally {
        this.lastProbeAt = this.now();
      }
    })();
    try { await this.inFlight; } finally { this.inFlight = null; }
  }
}

/** @param {Record<string, any>} account */
function isClaudeOAuth(account) {
  return account?.type === 'oauth' && providerOf(account) === 'anthropic' && account.disabled !== true;
}

/** @param {number|null|undefined} ms */
const iso = (ms) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * One row per Claude seat, the shape /teamclaude/quota (`seats`) and /teamclaude/resets return and the
 * lexicon documents. Times are ISO-8601 UTC; the plan renders local time. Reset counts are recomputed
 * at `now` from the kept grants, so an expired grant never shows.
 * @param {{ accounts: Record<string, any>[], ledger: WindowLedger|null, probe: ResetsProbe|null, staggerSeats?: { name: string, nextTouchAt: string|null }[], poolWeeklyRemaining?: number|null, now: number, dryRun?: boolean }} input
 */
export function seatRows({ accounts, ledger, probe, staggerSeats = [], poolWeeklyRemaining = null, now, dryRun = false }) {
  const claude = accounts.filter(isClaudeOAuth);
  const room = (/** @type {Record<string, any>} */ a) => num(a.quota?.unified7d) != null && a.quota.unified7d < 0.98;
  const unknown = (/** @type {Record<string, any>} */ a) => num(a.quota?.unified7d) == null;
  return claude.map((a) => {
    const q = a.quota || {};
    const weeklyUsed = num(q.unified7d);
    const weeklyResetAt = time(q.unified7dReset);
    const fiveReset = time(q.unified5hReset) != null && q.unified5hReset > now ? q.unified5hReset : null;
    const inWindow = fiveReset != null;
    const touch = staggerSeats.find((s) => s.name === a.name)?.nextTouchAt ?? null;
    const touchMs = touch ? Date.parse(touch) : NaN;
    const staggered = Number.isFinite(touchMs) && touchMs > now;
    const nextWindowAt = staggered ? touchMs : fiveReset;
    const w = windowsLeft(weeklyUsed, ledger ? ledger.burn(a.name) : { burn: null, windows: 0 });
    const seen = probe?.byName.get(a.name);
    const summary = seen?.kept ? resetSummary(seen.kept, now) : null;
    /** @type {Record<string, any>} */
    const row = {
      name: a.name,
      inWindow,
      windowEndsAt: iso(fiveReset),
      nextWindowAt: iso(nextWindowAt),
      nextWindowBasis: staggered ? 'stagger slot' : inWindow ? 'after this window' : 'on first use',
      weeklyUsed: weeklyUsed != null ? Math.round(weeklyUsed * 1000) / 1000 : null,
      weeklyResetAt: iso(weeklyResetAt),
      windowsLeft: w.windowsLeft,
      windowsLeftBasis: w.basis,
      resets: summary
        ? { ...summary, expiresAt: iso(summary.expiresAt), weeklyExpiresAt: iso(summary.weeklyExpiresAt), cooldownUntil: iso(summary.cooldownUntil), seenAt: iso(seen?.okAt) }
        : null,
      resetsError: seen ? seen.error : 'not probed yet',
      resetsTriedAt: iso(seen?.triedAt),
    };
    if (dryRun) {
      row.redeem = redeemVerdict(
        { name: a.name, weeklyUsed, weeklyResetAt, resets: summary },
        { poolWeeklyRemaining, othersWithRoom: claude.filter((o) => o !== a && room(o)).length, othersUnknown: claude.filter((o) => o !== a && unknown(o)).length },
        { now },
      );
    }
    return row;
  });
}
