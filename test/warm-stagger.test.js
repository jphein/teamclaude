import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStagger, slotMinutes, formatSlot, nextTouchAt, StaggerAnchors,
  GRACE_MS, POST_RESET_BUFFER_MS,
} from '../src/warm-stagger.js';
import { AccountManager } from '../src/account-manager.js';

// JP 2026-11-09 08:4x: "touch all active accounts several hours before I get
// up, that way if I use all the tokens then I only have to wait minutes for the
// next refresh instead of 5 hours". The windows are spread, not aligned.

const H = 3_600_000;
const M = 60_000;
const LA = 'America/Los_Angeles';
const cfg = { wake: '07:00', timezone: LA };
// Tue 2026-11-10 00:00 PST = 08:00Z.
const MIDNIGHT = Date.parse('2026-11-10T08:00:00Z');
const at = (/** @type {string} */ hhmm, day = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  return MIDNIGHT + day * 24 * H + h * H + m * M;
};

test('seven seats spread one window before wake: a refresh every ~43 minutes', () => {
  const s = /** @type {any} */ (normalizeStagger(cfg));
  const slots = Array.from({ length: 7 }, (_, i) => formatSlot(slotMinutes(i, 7, s)));
  assert.deepEqual(slots, ['02:00', '02:43', '03:26', '04:09', '04:51', '05:34', '06:17']);
  const three = Array.from({ length: 3 }, (_, i) => formatSlot(slotMinutes(i, 3, s)));
  assert.deepEqual(three, ['02:00', '03:40', '05:20']);
});

test('touch times: the slot and every 5 h after it that day, then rest until the next slot', () => {
  const s = /** @type {any} */ (normalizeStagger(cfg));
  const m = 2 * 60;
  assert.equal(nextTouchAt(m, s, at('01:00')), at('02:00'));
  assert.equal(nextTouchAt(m, s, at('02:00')), at('07:00'));
  assert.equal(nextTouchAt(m, s, at('07:00')), at('12:00'));
  assert.equal(nextTouchAt(m, s, at('12:00')), at('17:00'));
  // The +20 h step would run to 03:00 and miss the next slot, so none.
  assert.equal(nextTouchAt(m, s, at('17:00')), at('02:00', 1));
  // A slot before midnight's wrap: wake 03:00 puts seat 0 at 22:00.
  const late = /** @type {any} */ (normalizeStagger({ wake: '03:00', timezone: LA }));
  assert.equal(formatSlot(slotMinutes(0, 2, late)), '22:00');
  assert.equal(nextTouchAt(slotMinutes(0, 2, late), late, at('21:00')), at('22:00'));
});

test('bad settings are refused with a reason; absent or disabled is off', () => {
  assert.equal(normalizeStagger(null), null);
  assert.equal(normalizeStagger({ ...cfg, enabled: false }), null);
  assert.throws(() => normalizeStagger({ wake: '7am', timezone: LA }), /HH:MM/);
  assert.throws(() => normalizeStagger({ wake: '07:00' }), /timezone/);
  assert.throws(() => normalizeStagger({ ...cfg, timezone: 'Mars/Base' }), /timezone/);
  assert.throws(() => normalizeStagger({ ...cfg, spanMinutes: 301 }), /spanMinutes/);
  assert.throws(() => normalizeStagger({ ...cfg, minWeeklyRemaining: 2 }), /minWeeklyRemaining/);
});

/** A fake clock and timer queue, driven by `advance`. */
function harness(accounts, { now = at('01:00'), thresholds = { default: 0.93, unified5h: 0.95, unified7d: 0.9 } } = {}) {
  let clock = now;
  /** @type {{at: number, fn: Function, id: number}[]} */
  let timers = [];
  let nextId = 1;
  const setTimeoutFn = (/** @type {Function} */ fn, /** @type {number} */ ms) => {
    const t = { at: clock + ms, fn, id: nextId++ };
    timers.push(t);
    return t;
  };
  const clearTimeoutFn = (/** @type {any} */ t) => { timers = timers.filter(x => x !== t); };
  const am = new AccountManager(accounts.map(name => ({
    name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + 48 * H,
  })), thresholds);
  for (const a of am.accounts) a.credential = { accessToken: 't' };
  /** @type {{name: string, at: number}[]} */
  const touched = [];
  const warmer = {
    _isWarmCandidate: (/** @type {any} */ a) => !a.disabled && a.status !== 'error' && a.status !== 'throttled' && a.status !== 'exhausted' && !am.weekBarred(a),
    gate: /** @type {Promise<void>|null} */ (null),
    blind: false, // true: skip the warmer's own cold check, so the stagger's is the one tested
    async _warmTargets(/** @type {any[]} */ targets, /** @type {any} */ opts = {}) {
      if (this.gate) await this.gate;
      if (opts.shouldContinue && !opts.shouldContinue()) return false;
      for (const a of targets) {
        const reset = Number(a.quota.unified5hReset);
        if (!this.blind && Number.isFinite(reset) && reset > clock) continue; // the warmer's own re-check
        touched.push({ name: a.name, at: clock });
        a.quota.unified5h = 0.01;
        a.quota.unified5hReset = clock + 5 * H;
      }
      return true;
    },
  };
  const lines = /** @type {string[]} */ ([]);
  const st = new StaggerAnchors(am, warmer, { nowFn: () => clock, setTimeoutFn, clearTimeoutFn, log: l => lines.push(l) });
  async function advance(/** @type {number} */ to) {
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers[0];
      if (!t || t.at > to) break;
      timers.shift();
      clock = Math.max(clock, t.at);
      t.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    clock = to;
  }
  /** The process was suspended: the clock leaps, then the overdue timers fire late. */
  async function jump(/** @type {number} */ to) {
    clock = to;
    let fired = 0;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers[0];
      if (!t || t.at > to) break;
      timers.shift();
      fired++;
      t.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    return fired;
  }
  return { am, st, warmer, jump, touched, lines, advance, get clock() { return clock; } };
}

test('a cold seat is touched at its slot, and its windows then roll on the 5 h grid', async () => {
  const h = harness(['a', 'b', 'c']);
  h.st.configure(cfg);
  await h.advance(at('12:30'));
  const a = h.touched.filter(t => t.name === 'a').map(t => t.at);
  assert.deepEqual(a, [at('02:00'), at('07:00'), at('12:00')]);
  const firsts = ['a', 'b', 'c'].map(n => h.touched.find(t => t.name === n)?.at);
  assert.deepEqual(firsts, [at('02:00'), at('03:40'), at('05:20')]);
  assert.ok(h.lines.some(l => /touching "b" for its 03:40 slot/.test(l)));
});

test('never a double start: a seat mid-window at its slot is left alone', async () => {
  const h = harness(['a']);
  Object.assign(h.am.accounts[0].quota, { unified5h: 0.4, unified5hReset: at('04:30'), unified7d: 0.2, unified7dReset: at('00:00', 4) });
  h.st.configure(cfg);
  await h.advance(at('02:05'));
  assert.deepEqual(h.touched, []);
  assert.ok(h.lines.some(l => /leaving "a" at its 02:00 slot \(window running until/.test(l)));
});

test('a window ending just after the slot is followed by a touch at its reset', async () => {
  const h = harness(['a']);
  Object.assign(h.am.accounts[0].quota, { unified5h: 0.4, unified5hReset: at('02:10') });
  h.st.configure(cfg);
  await h.advance(at('02:20'));
  assert.deepEqual(h.touched.map(t => t.at), [at('02:10') + POST_RESET_BUFFER_MS]);
});

test('skips: re-login, a spent week, under 10% of the week left', async () => {
  // A 97% weekly slider, so 92% used is under it and only the stagger's own
  // floor (10% left) stops that seat.
  const h = harness(['relogin', 'spent', 'low', 'ok'], { thresholds: { default: 0.93, unified5h: 0.95, unified7d: 0.97 } });
  const [relogin, spent, low] = h.am.accounts;
  relogin.status = 'error';
  Object.assign(spent.quota, { unified7d: 0.98, unified7dReset: at('00:00', 3) });
  Object.assign(low.quota, { unified7d: 0.92, unified7dReset: at('00:00', 3) });
  h.st.configure(cfg);
  await h.advance(at('06:30'));
  assert.deepEqual(h.touched.map(t => t.name), ['ok']);
  assert.ok(h.lines.some(l => /"relogin" .*needs re-login/.test(l)));
  assert.ok(h.lines.some(l => /"spent" .*weekly limit reached/.test(l)));
  assert.ok(h.lines.some(l => /"low" .*under 10% of the week left/.test(l)));
});

test('a slot slept through by more than the grace is skipped, not replayed', async () => {
  const h = harness(['a'], { now: at('02:00') + GRACE_MS + M });
  h.st.configure(cfg);
  await h.advance(at('06:00'));
  assert.deepEqual(h.touched, []);
  assert.equal(h.st.status().seats[0].nextTouchAt, new Date(at('07:00')).toISOString());
});

test('re-applying the config (every reload does) never replays a slot already served', async () => {
  const h = harness(['a']);
  h.st.configure(cfg);
  await h.advance(at('02:05'));
  assert.equal(h.touched.length, 1);
  h.am.accounts[0].quota.unified5hReset = null; // as if the window were unknown again
  h.st.configure(cfg);
  await h.advance(at('02:15'));
  assert.equal(h.touched.length, 1);
});

test('status names each seat, its slot and its next touch', () => {
  const h = harness(['a', 'b']);
  h.st.configure(cfg);
  const s = h.st.status();
  assert.equal(s.enabled, true);
  assert.deepEqual(s.seats.map((/** @type {any} */ x) => [x.name, x.slot]), [['a', '02:00'], ['b', '04:30']]);
  assert.equal(s.seats[0].nextTouchAt, new Date(at('02:00')).toISOString());
  h.st.configure(null);
  assert.deepEqual(h.st.status(), { enabled: false });
});

test('a touch queued behind a running sweep is cancelled by turning the stagger off', async () => {
  const h = harness(['a']);
  /** @type {() => void} */
  let release = () => {};
  h.warmer.gate = new Promise(r => { release = () => r(); });
  h.st.configure(cfg);
  await h.advance(at('02:01'));
  h.st.configure(null);
  release();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(h.touched, []);
});

test('off and on again within the grace does not replay the slot it served', async () => {
  const h = harness(['a']);
  h.st.configure(cfg);
  await h.advance(at('02:05'));
  assert.equal(h.touched.length, 1);
  h.am.accounts[0].quota.unified5hReset = null;
  h.st.configure(null);
  h.st.configure(cfg);
  await h.advance(at('02:15'));
  assert.equal(h.touched.length, 1);
});

test('a window started by traffic during the deferral is not doubled', async () => {
  const h = harness(['a']);
  Object.assign(h.am.accounts[0].quota, { unified5h: 0.4, unified5hReset: at('02:10') });
  h.st.configure(cfg);
  await h.advance(at('02:05'));
  h.warmer.blind = true;
  // Traffic lands right after the reset, before the deferred touch.
  h.am.accounts[0].quota.unified5hReset = at('02:10') + 5 * H;
  await h.advance(at('02:20'));
  assert.deepEqual(h.touched, []);
});

test('a suspend of days steps over the missed slots instead of walking them', async () => {
  const h = harness(['a']);
  h.st.configure(cfg);
  await h.advance(at('02:05'));
  const before = h.touched.length;
  const fired = await h.jump(at('09:00', 3));
  assert.equal(fired, 1, 'the one overdue timer fires, and is not followed by a chain of past slots');
  assert.equal(h.touched.length, before);
  assert.equal(h.st.status().seats[0].nextTouchAt, new Date(at('12:00', 3)).toISOString());
});
