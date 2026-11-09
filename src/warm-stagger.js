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

import { localParts, localInstant, addCalendarDays } from './warmup-schedule.js';
import { warmApplicable } from './warmer.js';

export const WINDOW_MS = 5 * 60 * 60 * 1000;
export const DEFER_WITHIN_MS = 15 * 60 * 1000;
export const GRACE_MS = 20 * 60 * 1000;
export const POST_RESET_BUFFER_MS = 10 * 1000;
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
  const offset = n > 0 ? Math.round(i * s.spanMinutes / n) : 0;
  return (((first + offset) % 1440) + 1440) % 1440;
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
   */
  constructor(am, warmer, { nowFn = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, log = console.log } = {}) {
    this.am = am;
    this.warmer = warmer;
    this.nowFn = nowFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.log = log;
    this.settings = null;
    /** @type {Map<string, {minutes: number, nextAt: number|null, timer: any, lastAt: number|null, last: string|null}>} */
    this.seats = new Map();
    // The last touch time served per seat and slot, kept across stop() and
    // re-configure, so turning the stagger off and on never replays a slot.
    /** @type {Map<string, number>} */
    this.served = new Map();
    // Bumped by configure/stop; a touch from an older generation never sends.
    this.generation = 0;
  }

  get enabled() { return !!this.settings; }

  /** Apply a config value (null/absent turns it off). Throws on a bad value
   *  and leaves the running schedule as it was. Re-applying recomputes the
   *  slots, so a seat added or removed on reload is placed.
   *  @param {any} cfg */
  configure(cfg) {
    const settings = normalizeStagger(cfg);
    const previous = this.seats;
    this.stop();
    this.settings = settings;
    if (!settings) return;
    const roster = this._roster();
    roster.forEach((/** @type {any} */ account, /** @type {number} */ i) => {
      const minutes = slotMinutes(i, roster.length, settings);
      const old = previous.get(account.name);
      this.seats.set(account.name, {
        minutes, nextAt: null, timer: null,
        lastAt: this.served.get(`${account.name}@${minutes}`) ?? null,
        last: old && old.minutes === minutes ? old.last : null,
      });
    });
    const now = this.nowFn();
    for (const account of roster) this._arm(account, now - GRACE_MS);
    this.log(`[TeamClaude] Keep-warm stagger: ${roster.map((/** @type {any} */ a) => `"${a.name}" ${formatSlot(/** @type {any} */ (this.seats.get(a.name)).minutes)}`).join(', ')} (${settings.timezone}; wake ${settings.wake})`);
  }

  stop() {
    this.generation += 1;
    for (const seat of this.seats.values()) if (seat.timer) this.clearTimeoutFn(seat.timer);
    this.seats = new Map();
    this.settings = null;
  }

  /** Seats that hold a slot: every warmable seat that is not disabled, in
   *  config order. A seat whose week is spent keeps its slot and is skipped at
   *  it, so the others do not shift every time a week runs out. */
  _roster() {
    return this.am.accounts.filter((/** @type {any} */ a) => warmApplicable(a) && !a.disabled);
  }

  /** @param {any} account @param {number} after */
  _arm(account, after) {
    const seat = this.seats.get(account.name);
    if (!seat || !this.settings) return;
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
    }, Math.max(0, at - this.nowFn()));
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
    seat.lastAt = at;
    this.served.set(`${account.name}@${seat.minutes}`, at);
    const now = this.nowFn();
    const slot = formatSlot(seat.minutes);
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
      seats: [...this.seats.entries()].map(([name, s]) => ({
        name,
        slot: formatSlot(s.minutes),
        nextTouchAt: s.nextAt != null ? new Date(s.nextAt).toISOString() : null,
        last: s.last,
      })),
    };
  }
}
