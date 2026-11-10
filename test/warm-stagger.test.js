import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStagger, slotMinutes, formatSlot, nextTouchAt, StaggerAnchors,
  GRACE_MS, POST_RESET_BUFFER_MS, TOUCH_OFFSET_MS,
} from '../src/warm-stagger.js';
import { AccountManager } from '../src/account-manager.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// JP 2026-11-09 08:4x: "touch all active accounts several hours before I get
// up, that way if I use all the tokens then I only have to wait minutes for the
// next refresh instead of 5 hours". The windows are spread, not aligned.

const H = 3_600_000;
const M = 60_000;
const LA = 'America/Los_Angeles';
const cfg = { wake: '07:00', timezone: LA };
// A Los Angeles midnight at least two days ahead of the real clock. It must be
// in the future: the AccountManager clears windows against the real clock, so a
// fixed date became a time bomb the morning it passed (2026-11-10). The day and
// the four after it have no DST change, so local hours are fixed offsets.
const MIDNIGHT = (() => {
  const offset = (/** @type {number} */ t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: LA, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(t).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60_000) * 60_000;
  };
  let day = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 2 * 86_400_000;
  for (;;) {
    const mid = day + 8 * H; // 00:00 PST
    if (offset(mid) === -8 * H && offset(mid + 5 * 24 * H) === -8 * H) return mid;
    day += 86_400_000;
  }
})();
const at = (/** @type {string} */ hhmm, day = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  return MIDNIGHT + day * 24 * H + h * H + m * M;
};

test('seven seats spread one window before wake, on 10-minute marks: a refresh every 40-50 minutes', () => {
  const s = /** @type {any} */ (normalizeStagger(cfg));
  const slots = Array.from({ length: 7 }, (_, i) => formatSlot(slotMinutes(i, 7, s)));
  assert.deepEqual(slots, ['02:00', '02:40', '03:30', '04:10', '04:50', '05:30', '06:20']);
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
function harness(accounts, { now = at('01:00'), thresholds = { default: 0.93, unified5h: 0.95, unified7d: 0.9 }, statePath = null } = {}) {
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
        opts.outcomes?.push({ account: a, outcome: 'ok' });
        a.quota.unified5h = 0.01;
        a.quota.unified5hReset = clock + 5 * H;
      }
      return true;
    },
  };
  const lines = /** @type {string[]} */ ([]);
  const st = new StaggerAnchors(am, warmer, { nowFn: () => clock, setTimeoutFn, clearTimeoutFn, log: l => lines.push(l), statePath });
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
  const T = TOUCH_OFFSET_MS;
  const a = h.touched.filter(t => t.name === 'a').map(t => t.at);
  assert.deepEqual(a, [at('02:00') + T, at('07:00') + T, at('12:00') + T]);
  const firsts = ['a', 'b', 'c'].map(n => h.touched.find(t => t.name === n)?.at);
  assert.deepEqual(firsts, [at('02:00') + T, at('03:40') + T, at('05:20') + T]);
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
  assert.ok(fired <= 2, `the seat's overdue timer and the plan's fire once each, with no chain of past slots (fired ${fired})`);
  assert.equal(h.touched.length, before);
  assert.equal(h.st.status().seats[0].nextTouchAt, new Date(at('12:00', 3)).toISOString());
});

test('the reserve is asked again at send time, and a cancelled touch is reported as one', async () => {
  const h = harness(['a']);
  /** @type {() => void} */
  let release = () => {};
  h.warmer.gate = new Promise(r => { release = () => r(); });
  h.st.configure(cfg);
  await h.advance(at('02:01'));
  // While the touch waits, the week drops under the 10% reserve.
  Object.assign(h.am.accounts[0].quota, { unified7d: 0.95, unified7dReset: at('00:00', 3) });
  release();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(h.touched, []);
  assert.match(h.st.status().seats[0].last, /^cancelled .* before sending$/);
});

test('a completed touch is reported with the reset it produced', async () => {
  const h = harness(['a']);
  h.st.configure(cfg);
  await h.advance(at('02:05'));
  const want = new Date(at('07:00') + TOUCH_OFFSET_MS).toISOString().replace(/\./g, '\\.');
  assert.match(h.st.status().seats[0].last, new RegExp(`^touched .*, resets ${want}$`));
});

test('a seat warmed by someone else while the touch waited is not reported as touched', async () => {
  const h = harness(['a']);
  /** @type {() => void} */
  let release = () => {};
  h.warmer.gate = new Promise(r => { release = () => r(); });
  h.st.configure(cfg);
  await h.advance(at('02:01'));
  h.am.accounts[0].quota.unified5hReset = at('02:01') + 5 * H; // another sweep's warm-up
  release();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(h.touched, []);
  assert.match(h.st.status().seats[0].last, /^cancelled /);
});

test('each morning the slots go only to seats that can be touched: no holes for spent weeks', async () => {
  const names = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
  const h = harness(names, { now: at('01:00') });
  for (const n of ['s2', 's3', 's5', 's7']) {
    Object.assign(h.am.accounts[names.indexOf(n)].quota, { unified7d: 1, unified7dReset: at('00:00', 4) });
  }
  h.st.configure(cfg);
  await h.advance(at('01:55')); // the day's plan is made at 01:50
  const slots = Object.fromEntries(h.st.status().seats.map((/** @type {any} */ x) => [x.name, x.slot]));
  assert.deepEqual(slots, { s1: '02:00', s2: null, s3: null, s4: '03:40', s5: null, s6: '05:20', s7: null });
  assert.match(h.st.status().seats[1].last, /no slot today \(weekly limit reached\)/);
  await h.advance(at('06:00'));
  assert.deepEqual(h.touched.map(t => [t.name, formatSlot(Math.round((t.at - MIDNIGHT) / M))]), [['s1', '02:00'], ['s4', '03:40'], ['s6', '05:20']]);
});

test('a restart keeps the morning plan and never replays a served slot', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'tc-stagger-')), 'stagger.json');
  const h = harness(['a', 'b'], { statePath });
  h.st.configure(cfg);
  await h.advance(at('02:05'));
  assert.deepEqual(h.touched.map(t => t.name), ['a']);
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(saved.slots, { a: 2 * 60, b: 4 * 60 + 30 });
  // The restart: a new instance on the same file, the window reading lost, and
  // seat b now spent. The morning plan stands; a is not touched again.
  const h2 = harness(['a', 'b'], { now: at('02:06'), statePath });
  Object.assign(h2.am.accounts[1].quota, { unified7d: 1, unified7dReset: at('00:00', 4) });
  h2.st.configure(cfg);
  assert.deepEqual(h2.st.status().seats.map((/** @type {any} */ x) => x.slot), ['02:00', '04:30']);
  assert.ok(h2.lines.some(l => /plan kept/.test(l)));
  await h2.advance(at('02:20'));
  assert.deepEqual(h2.touched, []);
});

test('a plan from an earlier day is not reused', () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'tc-stagger-')), 'stagger.json');
  const h = harness(['a', 'b'], { statePath, now: at('01:00') });
  h.st.configure(cfg);
  const h2 = harness(['a', 'b'], { statePath, now: at('03:00', 1) });
  h2.st.configure(cfg);
  assert.ok(h2.lines.some(l => /plan made/.test(l)));
});
