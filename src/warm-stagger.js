// Staggered 5h-window anchors (fork; JP 2026-11-09).
//
// A 5h window starts at a seat's first request after its last one reset, so a
// pool whose windows all start together (the align mode) refreshes all at once:
// spend it and the next refresh is up to five hours away. This spreads the
// seats' windows evenly across one five-hour span ending at the wake time, so
// with N seats a refresh is never more than 5h/N away. A seat is touched (the
// warmer's one tiny request) at its slot and at every five hours after it the
// same day; the fifth step would end past the next day's slot, so the seat is
// left to rest until that slot, which is what keeps the daily anchor fixed even
// though 24 hours is not a multiple of five.
//
// A touch never starts a second window: a seat whose window is running is left
// alone, and one whose window ends within DEFER_WITHIN_MS of the slot is touched
// right after that reset instead, which keeps a seat on its slot when the
// reset Anthropic reports lands a little after it. Every eligibility rule of the
// keep-warm sweep applies (disabled, re-auth, throttled, week spent), plus a
// floor on the weekly quota left.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { localParts, localInstant, addCalendarDays } from './warmup-schedule.js';
import { warmApplicable } from './warmer.js';

export const WINDOW_MS = 5 * 60 * 60 * 1000;
export const DEFER_WITHIN_MS = 15 * 60 * 1000;
export const GRACE_MS = 20 * 60 * 1000;
export const POST_RESET_BUFFER_MS = 10 * 1000;
// Anthropic starts a 5h window at the 10-minute mark at or before the first
// request (measured 2026-11-10: 02:43 → resets 07:40, 04:51 → 09:50). Slots sit
// on those marks and a touch goes this long after one, so the window it starts
// runs exactly slot → slot + 5h and the previous one has surely ended.
export const TOUCH_OFFSET_MS = 10 * 1000;
// A failed reset touch is tried this many times in all, 60 s then 120 s apart (the lead's ruling after round 3 on PR 108).
export const FOLLOW_TRIES = 3;
export const FOLLOW_RETRY_MS = 60 * 1000;
// Each day's slots are handed out this long before the first one, over the
// seats that can be touched that morning (2026-11-10: four spent seats held
// empty slots and the refresh gaps doubled).
export const PLAN_LEAD_MINUTES = 10;
const SERVED_KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const STEPS_PER_DAY = 4; // slot, +5h, +10h, +15h; the window from +15h ends at +20h

/** @param {any} cfg */
export function normalizeStagger(cfg) {
  if (!cfg || cfg.enabled === false) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(cfg.wake || '07:00');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error('warmupStagger.wake must use HH:MM in the 00:00-23:59 range');
  }
  if (!cfg.timezone) throw new Error('warmupStagger.timezone is required');
  let timezone;
  try {
    timezone = new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`invalid IANA timezone: ${cfg.timezone}`);
  }
  const span = cfg.spanMinutes == null ? 300 : Number(cfg.spanMinutes);
  if (!Number.isInteger(span) || span < 0 || span > 300) {
    throw new Error('warmupStagger.spanMinutes must be an integer from 0 to 300');
  }
  const floor = cfg.minWeeklyRemaining == null ? 0.10 : Number(cfg.minWeeklyRemaining);
  if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new Error('warmupStagger.minWeeklyRemaining must be a fraction from 0 to 1');
  }
  return {
    wake: `${match[1]}:${match[2]}`,
    wakeMinutes: Number(match[1]) * 60 + Number(match[2]),
    timezone,
    spanMinutes: span,
    minWeeklyRemaining: floor,
  };
}

/** @typedef {NonNullable<ReturnType<typeof normalizeStagger>>} StaggerSettings */

/** Seat i of n: its slot as minutes after local midnight. The first slot is
 *  one window before wake (its window ends at wake), the rest spread evenly
 *  across the span after it.
 *  @param {number} i @param {number} n @param {StaggerSettings} s */
export function slotMinutes(i, n, s) {
  const first = s.wakeMinutes - 300;
  const offset = n > 0 ? i * s.spanMinutes / n : 0;
  const onMark = Math.round((first + offset) / 10) * 10;
  return ((onMark % 1440) + 1440) % 1440;
}

/** The local instants at `minutes` past midnight around `around`, ascending.
 *  @param {number} minutes @param {StaggerSettings} s @param {number} around */
function dailyInstants(minutes, s, around) {
  const today = localParts(around, s.timezone);
  const out = [];
  for (let d = -2; d <= 2; d++) {
    const t = localInstant({ ...addCalendarDays(today, d), hour: Math.floor(minutes / 60), minute: minutes % 60 }, s.timezone);
    if (t != null) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/** The latest plan instant at or before `now`, and the next one after it.
 *  A plan is made PLAN_LEAD_MINUTES (elapsed) before the day's first slot as
 *  resolved, rounding included, so a plan time that a DST change skips still
 *  plans a slot that exists; a day whose first slot does not exist has none.
 *  @param {StaggerSettings} s @param {number} now */
export function planWindow(s, now) {
  const all = dailyInstants(slotMinutes(0, 1, s), s, now).map(t => t - PLAN_LEAD_MINUTES * 60_000);
  const last = all.filter(t => t <= now).pop() ?? null;
  const next = all.find(t => t > now) ?? null;
  return { last, next };
}

/** @param {number} minutes */
export function formatSlot(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The first touch time strictly after `after` for a seat whose slot is
 *  `minutes` past local midnight: the slot on some local day, or 5, 10 or 15
 *  hours after it. Elapsed hours, not wall-clock ones, since a window is.
 *  @param {number} minutes @param {StaggerSettings} s @param {number} after
 *  @returns {number|null} */
export function nextTouchAt(minutes, s, after) {
  const today = localParts(after, s.timezone);
  let best = null;
  for (let d = -1; d <= 2; d++) {
    const date = addCalendarDays(today, d);
    const slot = localInstant({ ...date, hour: Math.floor(minutes / 60), minute: minutes % 60 }, s.timezone);
    if (slot == null) continue; // a slot inside a spring-forward gap: skip the day
    for (let k = 0; k < STEPS_PER_DAY; k++) {
      const at = slot + k * WINDOW_MS;
      if (at > after && (best == null || at < best)) best = at;
    }
  }
  return best;
}

export class StaggerAnchors {
  /**
   * @param {any} am the account manager
   * @param {any} warmer the Warmer whose touch and eligibility rules are used
   * @param {Object} [opts]
   * @param {() => number} [opts.nowFn]
   * @param {Function} [opts.setTimeoutFn]
   * @param {Function} [opts.clearTimeoutFn]
   * @param {(line: string) => void} [opts.log]
   * @param {string|null} [opts.statePath] where the day's plan and the served
   *   slots are kept across restarts (null: memory only)
   */
  constructor(am, warmer, { nowFn = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, log = console.log, statePath = null } = {}) {
    this.statePath = statePath;
    /** @type {any} */
    this.planTimer = null;
    /** @type {number|null} */
    this.planAt = null;
    /** @type {number|null} */
    this.nextPlanAt = null;
    this.am = am;
    this.warmer = warmer;
    this.nowFn = nowFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.log = log;
    this.settings = null;
    /** @type {Map<string, {minutes: number|null, nextAt: number|null, timer: any, lastAt: number|null, last: string|null}>} */
    this.seats = new Map();
    // The last touch time served per seat and slot, kept across stop() and
    // re-configure, so turning the stagger off and on never replays a slot.
    /** @type {Map<string, number>} */
    this.served = new Map();
    // Bumped by configure/stop; a touch from an older generation never sends.
    this.generation = 0;
    // Each seat's follower (JP 2026-11-27 13:0x: "touch it right away after it resets, not wait"): a timer at
    // that seat's next reset, and what happened at the last one. Kept across the daily re-plan; the timers
    // are dropped by stop(). Bumped by stop() only, so a re-plan never cancels a touch in flight.
    // lastResetAt/touchedAt/touchedBy/requestId: the last reset a touch SUCCEEDED for (the lead's ruling after
    // round 3 on PR 108); pendingResetAt: a reset still without one (retrying, given up, skipped); settledResetAt:
    // the reset nothing more is done for (success or a final decision); inFlight: a touch is being sent.
    /** @type {Map<string, {timer: any, resetAt: number|null, weekly?: boolean, inFlight: boolean, attempts: number, settledResetAt: number|null, lastResetAt: number|null, touchedAt: number|null, touchedBy: string|null, requestId: string|null, pendingResetAt: number|null, note: string|null}>} */
    this.follow = new Map();
    this.followGeneration = 0;
    /** @type {(() => void)|null} */
    this.unsubscribe = null;
    // When this process first configured the stagger: a reset older than that, touched right after, was missed
    // while the proxy was down ("touched on boot").
    /** @type {number|null} */
    this.firstConfiguredAt = null;
  }

  get enabled() { return !!this.settings; }

  /** Apply a config value (null/absent turns it off). Throws on a bad value
   *  and leaves the running schedule as it was. The day's plan is reused when
   *  one was made since the last plan time (a restart or reload mid-day keeps
   *  the morning's slots); otherwise it is made now.
   *  @param {any} cfg */
  configure(cfg) {
    const settings = normalizeStagger(cfg);
    this.stop();
    this.settings = settings;
    if (!settings) return;
    try { this._configure(); } catch (err) { this.stop(); throw err; }
  }

  _configure() {
    const settings = /** @type {StaggerSettings} */ (this.settings);
    const saved = this._load();
    for (const [k, v] of Object.entries(saved?.served || {})) {
      if (typeof v === 'number' && !((this.served.get(k) ?? -Infinity) >= v)) this.served.set(k, v);
    }
    const now = this.nowFn();
    const { last } = planWindow(settings, now);
    const sig = this._signature();
    const reuse = saved && saved.signature === sig && last != null && saved.planAt === last && saved.slots
      ? saved.slots : null;
    this._applyPlan(reuse, last ?? now, reuse ? 'kept' : 'made');
    this._armPlan();
    // Every response a seat gets carries its reset: a window a request starts is followed from that moment, and
    // a request that started it after the reset is recorded, by its id, as that reset's touch.
    this.unsubscribe = this.am.onSeatRequest?.((/** @type {{account: any, requestId?: string|null}} */ { account, requestId }) =>
      this._follow(account, { requestId: requestId ?? null })) ?? null;
    if (this.firstConfiguredAt == null) this.firstConfiguredAt = now;
    for (const a of this._roster()) this._follow(a);
  }

  /** The reset a seat's next touch follows: its weekly reset while the week is spent, else its 5 h reset, else
   *  (the manager clears a passed reset) the last 5 h window it saw end. One already past is overdue and touched
   *  at once, however long ago it passed (PR 108 round 2: a reset missed while the proxy was down is touched on
   *  boot). @param {any} account */
  _resetToFollow(account) {
    const q = account.quota || {};
    // null is no reset, never 0 (Number(null) is 0: a seat with no reading would read as overdue since 1970)
    const ms = (/** @type {any} */ v) => (v == null || v === '' ? NaN : Number(v));
    if (this.am.weekBarred?.(account)) {
      const week = ms(q.unified7dReset);
      return Number.isFinite(week) && week > 0 ? week : null;
    }
    const five = ms(q.unified5hReset);
    if (Number.isFinite(five) && five > 0) return five;
    // Not compared with the clock: a clock stepped back makes it "not happened yet" (re-scheduled), never unknown.
    const seen = ms(account._5hWindowSeen);
    return Number.isFinite(seen) && seen > 0 ? seen : null;
  }

  /** Record what became of `resetAt`, and stop working on it. A success sets the last-reset fields; anything else
   *  leaves them and marks the reset pending with the reason. @param {any} f @param {number} resetAt
   *  @param {{touchedAt: number, touchedBy: string, requestId?: string|null}|null} touch @param {string|null} note */
  _settle(f, resetAt, touch, note) {
    if (f.timer) { this.clearTimeoutFn(f.timer); f.timer = null; }
    Object.assign(f, { resetAt: null, attempts: 0, settledResetAt: resetAt, note });
    if (touch) Object.assign(f, { lastResetAt: resetAt, touchedAt: touch.touchedAt, touchedBy: touch.touchedBy, requestId: touch.requestId ?? null, pendingResetAt: null });
    else f.pendingResetAt = resetAt;
  }

  /** @param {any} account @param {any} f @param {number} target @param {number} delayMs */
  _armFollow(account, f, target, delayMs) {
    if (f.timer) this.clearTimeoutFn(f.timer);
    f.resetAt = target;
    // which reset it is: the week's (the seat's week is spent) or the 5 h window's
    f.weekly = !!this.am.weekBarred?.(account);
    const settings = this.settings;
    const timer = this.setTimeoutFn(() => {
      if (this.settings !== settings || this.follow.get(account.name) !== f) return;
      f.timer = null;
      this._followFire(account, f, target)
        .catch((/** @type {any} */ err) => this.log(`[TeamClaude] Keep-warm stagger: the follower of "${account.name}" failed: ${err?.message || err}`))
        .finally(() => { if (this.settings === settings) this._follow(account); });
    }, Math.max(0, delayMs));
    timer?.unref?.();
    f.timer = timer;
  }

  /** Arm (or re-arm) the seat's touch for its next reset. Cheap when nothing changed: every seat request calls
   *  it. @param {any} account @param {{requestId?: string|null}} [from] the response that called it, if one did */
  _follow(account, { requestId = null } = {}) {
    if (!this.settings || !warmApplicable(account) || account.disabled) return;
    let f = this.follow.get(account.name);
    if (!f) {
      f = { timer: null, resetAt: null, inFlight: false, attempts: 0, settledResetAt: null, lastResetAt: null, touchedAt: null, touchedBy: null, requestId: null, pendingResetAt: null, note: null };
      this.follow.set(account.name, f);
    }
    // A touch in flight is the one touch for its reset: a poll, a request or a slot meanwhile adds none. It
    // re-arms when it ends.
    if (f.inFlight) return;
    const target = this._resetToFollow(account);
    if (f.timer && target === f.resetAt) return;
    const now = this.nowFn();
    // The reset armed for passed and a new window is running before the touch. Recorded as that reset's touch only
    // when a response said so, with its request id; a window seen without one is not counted as a touch.
    if (f.resetAt != null && f.resetAt <= now && target !== f.resetAt) {
      if (requestId != null) {
        this._settle(f, f.resetAt, { touchedAt: now, touchedBy: 'request', requestId }, `window started by request ${requestId}`);
      } else {
        this.log(`[TeamClaude] Keep-warm stagger: "${account.name}" reset ${new Date(f.resetAt).toISOString()}: window running, no response seen`);
        this._settle(f, f.resetAt, null, 'window running, no response seen');
      }
    }
    if (f.timer) { this.clearTimeoutFn(f.timer); f.timer = null; }
    if (target !== f.resetAt) f.attempts = 0;
    f.resetAt = null;
    if (target == null || target === f.settledResetAt) return;
    this._armFollow(account, f, target, target + TOUCH_OFFSET_MS - now);
  }

  /** @param {any} account @param {any} f @param {number} resetAt */
  async _followFire(account, f, resetAt) {
    const name = account.name;
    const at = new Date(resetAt).toISOString();
    const now = this.nowFn();
    // The captured reset must still be the seat's, and must have happened (the lead's ruling after round 3). A
    // weekly reset the manager has cleared (the seat is no longer week-barred, the clock past it) did happen.
    const current = this._resetToFollow(account);
    const weekCleared = f.weekly && !this.am.weekBarred?.(account) && now >= resetAt;
    if (current !== resetAt && !weekCleared) {
      // Void: _follow (run when this returns) records what replaced it and arms the current reset.
      this.log(`[TeamClaude] Keep-warm stagger: "${name}": reset ${at} is no longer the seat's (now ${current != null ? new Date(current).toISOString() : 'unknown'}): timer void`);
      return;
    }
    if (now < resetAt) {
      this.log(`[TeamClaude] Keep-warm stagger: "${name}": reset ${at} has not happened yet (the clock reads ${new Date(now).toISOString()}): re-scheduled`);
      this._armFollow(account, f, resetAt, resetAt + TOUCH_OFFSET_MS - now);
      return;
    }
    // Overdue (the proxy was down, or the host slept): touched now all the same, and the record says how late.
    const onBoot = this.firstConfiguredAt != null && resetAt < this.firstConfiguredAt && now - this.firstConfiguredAt <= GRACE_MS;
    const late = now - resetAt - TOUCH_OFFSET_MS > GRACE_MS || onBoot
      ? `missed by ${Math.round((now - resetAt) / 60000)} min, touched ${onBoot ? 'on boot' : 'late'}` : null;
    const why = this.skipReason(account);
    if (why) {
      this.log(`[TeamClaude] Keep-warm stagger: leaving "${name}" at its reset ${at} (${why})`);
      this._settle(f, resetAt, null, `left (${why})`);
      return;
    }
    const running = Number(account.quota?.unified5hReset);
    if (Number.isFinite(running) && running > now) {
      // A new window, and no response recorded it as this reset's touch (that is _follow's, by request id): not
      // counted as a touch, so the CHECK warns on it.
      this.log(`[TeamClaude] Keep-warm stagger: "${name}" reset ${at}: window running, no response seen`);
      this._settle(f, resetAt, null, 'window running, no response seen');
      return;
    }
    f.inFlight = true;
    f.attempts += 1;
    /** @type {string|null} */
    let failure = null;
    try {
      const generation = this.followGeneration;
      this.log(`[TeamClaude] Keep-warm stagger: touching "${name}" at its reset ${at}${late ? ` (${late})` : ''}${f.attempts > 1 ? ` (try ${f.attempts}/${FOLLOW_TRIES})` : ''}`);
      /** @type {{account: any, outcome: string}[]} */
      const outcomes = [];
      await this.warmer._warmTargets([account], {
        outcomes,
        waitForRunning: true,
        allowWhileSuspended: true,
        deadline: Math.max(resetAt, now) + GRACE_MS + FOLLOW_TRIES * FOLLOW_RETRY_MS,
        shouldContinue: () => generation === this.followGeneration
          && this.follow.get(name) === f
          && this.skipReason(account) == null,
      });
      const outcome = outcomes.find(o => o.account === account)?.outcome ?? 'skipped';
      if (outcome === 'ok') this._settle(f, resetAt, { touchedAt: this.nowFn(), touchedBy: 'stagger' }, late);
      else if (outcome === 'skipped') {
        this.log(`[TeamClaude] Keep-warm stagger: touch of "${name}" at its reset ${at} cancelled before sending`);
        this._settle(f, resetAt, null, 'cancelled before sending');
      } else failure = outcome.replace(/^error: /, '');
    } catch (/** @type {any} */ err) {
      failure = `exception: ${err?.message || err}`;
    } finally {
      f.inFlight = false;
    }
    if (failure == null) return;
    // Retried with backoff, never dropped after one failure; each failure is logged with its reason.
    if (f.attempts < FOLLOW_TRIES) {
      const wait = FOLLOW_RETRY_MS * 2 ** (f.attempts - 1);
      const note = `touch failed: ${failure} (try ${f.attempts}/${FOLLOW_TRIES}, next in ${wait / 1000} s)`;
      this.log(`[TeamClaude] Keep-warm stagger: touch of "${name}" at its reset ${at} failed: ${failure} (try ${f.attempts}/${FOLLOW_TRIES}, next in ${wait / 1000} s)`);
      f.pendingResetAt = resetAt;
      f.note = note;
      this._armFollow(account, f, resetAt, wait);
    } else {
      this.log(`[TeamClaude] Keep-warm stagger: touch of "${name}" at its reset ${at} failed: ${failure} (gave up after ${f.attempts} tries)`);
      this._settle(f, resetAt, null, `touch failed: ${failure} (gave up after ${f.attempts} tries)`);
    }
  }

  /** What a saved plan must match to be reused. */
  _signature() {
    const s = /** @type {StaggerSettings} */ (this.settings);
    return `${s.wake}|${s.timezone}|${s.spanMinutes}|${s.minWeeklyRemaining}`;
  }

  /** Hand out slots (or take `slots` as given), then arm every slotted seat.
   *  @param {Record<string, number|null>|null} slots @param {number} planAt @param {string} how */
  _applyPlan(slots, planAt, how) {
    const settings = /** @type {StaggerSettings} */ (this.settings);
    for (const seat of this.seats.values()) if (seat.timer) this.clearTimeoutFn(seat.timer);
    const previous = this.seats;
    this.seats = new Map();
    this.generation += 1;
    const roster = this._roster();
    /** @type {Record<string, number|null>} */
    const plan = {};
    /** @type {Record<string, string>} */
    const why = {};
    if (slots) {
      for (const a of roster) plan[a.name] = typeof slots[a.name] === 'number' ? slots[a.name] : null;
    } else {
      const eligible = [];
      for (const a of roster) {
        const r = this.skipReason(a);
        if (r) { plan[a.name] = null; why[a.name] = r; } else eligible.push(a);
      }
      eligible.forEach((a, i) => { plan[a.name] = slotMinutes(i, eligible.length, settings); });
    }
    for (const a of roster) {
      const minutes = plan[a.name];
      const old = previous.get(a.name);
      this.seats.set(a.name, {
        minutes, nextAt: null, timer: null,
        lastAt: minutes == null ? null : this.served.get(`${a.name}@${minutes}`) ?? null,
        last: minutes == null
          ? `no slot today${why[a.name] ? ` (${why[a.name]})` : ''}`
          : (old && old.minutes === minutes ? old.last : null),
      });
    }
    this.planAt = planAt;
    const now = this.nowFn();
    for (const a of roster) if (plan[a.name] != null) this._arm(a, now - GRACE_MS);
    this._save(plan);
    const slotted = roster.filter(a => plan[a.name] != null).map(a => `"${a.name}" ${formatSlot(/** @type {number} */ (plan[a.name]))}`);
    const none = roster.filter(a => plan[a.name] == null).map(a => `"${a.name}"${why[a.name] ? ` (${why[a.name]})` : ''}`);
    this.log(`[TeamClaude] Keep-warm stagger: plan ${how} for ${new Date(planAt).toISOString()}: ${slotted.join(', ') || 'no seat can be touched'}${none.length ? `; no slot: ${none.join(', ')}` : ''} (${settings.timezone}; wake ${settings.wake})`);
  }

  /** Re-plan every day PLAN_LEAD_MINUTES before the first slot. */
  _armPlan() {
    if (!this.settings) return;
    const settings = this.settings;
    const { next } = planWindow(settings, this.nowFn());
    this.nextPlanAt = next;
    if (next == null) return;
    const t = this.setTimeoutFn(() => {
      if (this.settings !== settings) return;
      this.planTimer = null;
      // The plan time this run serves; after a long suspend that is the latest
      // one passed, not the one the timer was set for.
      this._applyPlan(null, planWindow(settings, this.nowFn()).last ?? next, 'made');
      this._armPlan();
    }, Math.max(0, next - this.nowFn()));
    t?.unref?.();
    this.planTimer = t;
  }

  /** The saved state, validated as a whole; anything malformed is ignored
   *  entirely (and logged) rather than trusted in part. */
  _load() {
    if (!this.statePath) return null;
    let raw;
    try { raw = JSON.parse(readFileSync(this.statePath, 'utf8')); } catch { return null; }
    const now = this.nowFn();
    const okTime = (/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v)
      && v > now - SERVED_KEEP_MS - 86_400_000 && v < now + 2 * 86_400_000;
    const okSlot = (/** @type {any} */ v) => v === null || (Number.isInteger(v) && v >= 0 && v < 1440);
    const valid = raw && typeof raw === 'object'
      && typeof raw.signature === 'string'
      && (raw.planAt === null || okTime(raw.planAt))
      && raw.slots && typeof raw.slots === 'object' && Object.values(raw.slots).every(okSlot)
      && raw.served && typeof raw.served === 'object' && Object.values(raw.served).every(okTime);
    if (!valid) {
      this.log(`[TeamClaude] Keep-warm stagger: ignoring a malformed state file ${this.statePath}`);
      return null;
    }
    return raw;
  }

  /** Write the state; false when it could not be written (memory-only is
   *  true). @param {Record<string, number|null>} [plan] @returns {boolean} */
  _save(plan) {
    if (!this.statePath || !this.settings) return true;
    const now = this.nowFn();
    /** @type {Record<string, number>} */
    const served = {};
    for (const [k, v] of this.served) if (now - v < SERVED_KEEP_MS) served[k] = v;
    const slots = plan ?? Object.fromEntries([...this.seats].map(([n, s]) => [n, s.minutes]));
    try {
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ signature: this._signature(), planAt: this.planAt, slots, served }) + '\n', { mode: 0o600 });
      renameSync(tmp, this.statePath);
      return true;
    } catch (err) {
      this.log(`[TeamClaude] Keep-warm stagger: could not save its state: ${/** @type {any} */ (err)?.message || err}`);
      return false;
    }
  }

  stop() {
    this.generation += 1;
    this.followGeneration += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const f of this.follow.values()) {
      if (f.timer) this.clearTimeoutFn(f.timer);
      f.timer = null;
      f.resetAt = null;
    }
    if (this.planTimer) { this.clearTimeoutFn(this.planTimer); this.planTimer = null; }
    for (const seat of this.seats.values()) if (seat.timer) this.clearTimeoutFn(seat.timer);
    this.seats = new Map();
    this.settings = null;
  }

  /** Seats a plan considers: every warmable seat that is not disabled, in
   *  config order. Each day's plan gives slots only to those that can be
   *  touched then, so a spent week leaves no hole; within the day the slots
   *  stay put, and a seat whose week resets mid-day joins the next plan. */
  /** @returns {any[]} */
  _roster() {
    return this.am.accounts.filter((/** @type {any} */ a) => warmApplicable(a) && !a.disabled);
  }

  /** @param {any} account @param {number} after */
  _arm(account, after) {
    const seat = this.seats.get(account.name);
    if (!seat || !this.settings || seat.minutes == null) return;
    // A touch time already handled is never replayed by a re-arm, and one
    // further back than the grace (a long suspend) is stepped over at once
    // rather than walked one zero-delay timer at a time.
    const from = Math.max(after, seat.lastAt ?? -Infinity, this.nowFn() - GRACE_MS);
    const at = nextTouchAt(seat.minutes, this.settings, from);
    seat.nextAt = at;
    if (at == null) return;
    const settings = this.settings;
    const timer = this.setTimeoutFn(() => {
      if (this.settings !== settings || this.seats.get(account.name) !== seat) return;
      seat.timer = null;
      this._fire(account, at).catch(() => {}).finally(() => {
        if (this.settings === settings && this.seats.get(account.name) === seat) this._arm(account, at);
      });
    }, Math.max(0, at + TOUCH_OFFSET_MS - this.nowFn()));
    timer?.unref?.();
    seat.timer = timer;
  }

  /** Why `account` is not touched now, or null when it may be. @param {any} account */
  skipReason(account) {
    if (account.disabled) return 'disabled';
    if (account.status === 'error') return 'needs re-login';
    if (account.status === 'exhausted' || account.status === 'throttled') return account.status;
    if (this.am.weekBarred?.(account)) return 'weekly limit reached';
    const weekly = this.am._governingWindow?.(account, null)?.utilization;
    if (weekly != null && this.settings && 1 - weekly < this.settings.minWeeklyRemaining) {
      return `under ${Math.round(this.settings.minWeeklyRemaining * 100)}% of the week left`;
    }
    if (!this.warmer._isWarmCandidate(account)) return 'not eligible';
    return null;
  }

  /** @param {any} account @param {number} at the touch time being served */
  async _fire(account, at) {
    const seat = this.seats.get(account.name);
    if (!seat) return;
    if (seat.minutes == null) return;
    seat.lastAt = at;
    this.served.set(`${account.name}@${seat.minutes}`, at);
    const now = this.nowFn();
    const slot = formatSlot(seat.minutes);
    // A slot is served only once it is on disk: a touch whose record could
    // not be written could be replayed by a restart, so it is not sent.
    if (!this._save()) {
      seat.last = `not sent at ${new Date(at).toISOString()} (could not record the slot)`;
      return;
    }
    if (now - at > GRACE_MS) {
      seat.last = `missed ${new Date(at).toISOString()} (woke ${Math.round((now - at) / 60000)}m late)`;
      return;
    }
    const why = this.skipReason(account);
    if (why) {
      seat.last = `left at ${new Date(at).toISOString()} (${why})`;
      this.log(`[TeamClaude] Keep-warm stagger: leaving "${account.name}" at its ${slot} slot (${why})`);
      return;
    }
    const reset = Number(account.quota?.unified5hReset);
    if (Number.isFinite(reset) && reset > now) {
      if (reset - now <= DEFER_WITHIN_MS) {
        const runAt = reset + POST_RESET_BUFFER_MS;
        this.log(`[TeamClaude] Keep-warm stagger: "${account.name}" ${slot} slot waits for its window to end at ${new Date(reset).toISOString()}`);
        await new Promise(resolve => {
          const t = this.setTimeoutFn(resolve, Math.max(0, runAt - this.nowFn()));
          t?.unref?.();
        });
        if (this.seats.get(account.name) !== seat) return;
        return this._touch(account, at, slot);
      }
      seat.last = `left at ${new Date(at).toISOString()} (window running until ${new Date(reset).toISOString()})`;
      this.log(`[TeamClaude] Keep-warm stagger: leaving "${account.name}" at its ${slot} slot (window running until ${new Date(reset).toISOString()})`);
      return;
    }
    return this._touch(account, at, slot);
  }

  /** @param {any} account @param {number} at @param {string} slot */
  async _touch(account, at, slot) {
    const seat = this.seats.get(account.name);
    if (!seat) return;
    const why = this.skipReason(account);
    if (why) { seat.last = `left at ${new Date(at).toISOString()} (${why})`; return; }
    // Re-read after any deferral: traffic may have started a window meanwhile.
    const running = Number(account.quota?.unified5hReset);
    if (Number.isFinite(running) && running > this.nowFn()) {
      seat.last = `left at ${new Date(at).toISOString()} (window started meanwhile, until ${new Date(running).toISOString()})`;
      return;
    }
    // A known reset is its follower's (reset + 10 s); the slot starts only a seat whose reset is unknown (the
    // lead's rule on PR 108: the follower wins when a reset is known).
    if (this.follow.get(account.name)?.resetAt != null) {
      seat.last = `left at ${new Date(at).toISOString()} (reset known: its follower touches it)`;
      return;
    }
    const generation = this.generation;
    this.log(`[TeamClaude] Keep-warm stagger: touching "${account.name}" for its ${slot} slot at ${new Date(this.nowFn()).toISOString()}`);
    // The warmer re-checks that the seat is still cold right before it sends,
    // so a request that started the window meanwhile is not doubled.
    /** @type {{account: any, outcome: string}[]} */
    const outcomes = [];
    await this.warmer._warmTargets([account], {
      outcomes,
      waitForRunning: true,
      allowWhileSuspended: true,
      deadline: at + GRACE_MS + DEFER_WITHIN_MS,
      // Checked by the warmer right before it sends, after any wait behind a
      // running sweep or a token refresh: a stop or re-configure meanwhile, or
      // the seat falling under a skip rule (the weekly reserve), cancels it.
      shouldContinue: () => generation === this.generation
        && this.seats.get(account.name) === seat
        && this.skipReason(account) == null,
    });
    // Report what this call did, not what was asked of it or what another
    // sweep did to the same seat meanwhile.
    const outcome = outcomes.find(o => o.account === account)?.outcome ?? 'skipped';
    const reset = Number(account.quota?.unified5hReset);
    const resets = Number.isFinite(reset) && reset > this.nowFn() ? `, resets ${new Date(reset).toISOString()}` : '';
    if (outcome === 'skipped') seat.last = `cancelled ${new Date(this.nowFn()).toISOString()} before sending`;
    else if (outcome === 'ok') seat.last = `touched ${new Date(this.nowFn()).toISOString()}${resets}`;
    else seat.last = `touch failed ${new Date(this.nowFn()).toISOString()}: ${outcome.replace(/^error: /, '')}`;
    this._follow(account);
  }

  /** For /teamclaude/quota and /status. */
  status() {
    if (!this.settings) return { enabled: false };
    return {
      enabled: true,
      wake: this.settings.wake,
      timezone: this.settings.timezone,
      spanMinutes: this.settings.spanMinutes,
      minWeeklyRemaining: this.settings.minWeeklyRemaining,
      planAt: this.planAt != null ? new Date(this.planAt).toISOString() : null,
      nextPlanAt: this.nextPlanAt != null ? new Date(this.nextPlanAt).toISOString() : null,
      seats: [...this.seats.entries()].map(([name, s]) => {
        const f = this.follow.get(name);
        const iso = (/** @type {number|null|undefined} */ t) => (t != null ? new Date(t).toISOString() : null);
        return {
          name,
          slot: s.minutes == null ? null : formatSlot(s.minutes),
          nextTouchAt: s.nextAt != null ? new Date(s.nextAt).toISOString() : null,
          last: s.last,
          // The follower: the last reset a touch succeeded for and that touch; a later reset still without one
          // (pendingResetAt, with why in followNote); the next reset it waits for. The quota CHECK warns on a
          // touch more than 60 s after its reset, and on a pending reset more than 60 s old.
          lastResetAt: iso(f?.lastResetAt),
          pendingResetAt: iso(f?.pendingResetAt),
          touchedAt: iso(f?.touchedAt),
          touchLagSeconds: f?.touchedAt != null && f.lastResetAt != null ? Math.round((f.touchedAt - f.lastResetAt) / 1000) : null,
          touchedBy: f?.touchedBy ?? null,
          touchRequestId: f?.requestId ?? null,
          followNote: f?.note ?? null,
          nextFollowAt: iso(f?.resetAt),
        };
      }),
    };
  }
}
