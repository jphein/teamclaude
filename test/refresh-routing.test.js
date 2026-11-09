import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// JP 2026-11-09: "the forwarder spends the seat whose reset is NEAREST while it
// still has tokens (burn the one about to refresh first, keep the fresh ones in
// reserve), so an exhausted pool is always minutes from the next refresh".

const H = 3600_000;
const OPUS = 'claude-opus-5-5';

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 24 * H };
}

/** Same week on every seat, so only the 5h window tells them apart. */
function mgr(refresh, names = ['fresh', 'soon', 'cold']) {
  const am = new AccountManager(names.map(oauth), { default: 0.93, unified5h: 0.95, unified7d: 0.9 },
    { expiryRouting: { enabled: true, tolerance: 1.2, rebalance: true, rank: 'soonest', refresh } });
  const week = Date.now() + 80 * H;
  for (const a of am.accounts) Object.assign(a.quota, { unified7d: 0.3, unified7dReset: week });
  return am;
}
const win = (/** @type {any} */ a, used, hours) => Object.assign(a.quota, { unified5h: used, unified5hReset: Date.now() + hours * H });

function quiet(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { return { value: fn(), lines }; } finally { console.log = orig; }
}

test('nearest: the seat whose window resets soonest is spent first; a cold seat last', () => {
  const am = mgr('nearest');
  const [fresh, soon] = am.accounts;
  win(fresh, 0.05, 4.5);
  win(soon, 0.6, 0.5);
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'soon');
  // Spent past the 5h slider: the next nearest running window, not the cold seat.
  win(soon, 0.96, 0.5);
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'fresh');
});

test('nearest moves the cursor off a fresh window to one about to refresh, once', () => {
  const am = mgr('nearest');
  const [fresh, soon] = am.accounts;
  win(fresh, 0.05, 4.5);
  win(soon, 0.6, 0.5);
  am._setCurrent(fresh);
  const { value, lines } = quiet(() => am.getActiveAccount(null, OPUS));
  assert.equal(value.name, 'soon');
  assert.equal(lines.filter(l => l.includes('Refresh routing')).length, 1);
  const again = quiet(() => am.getActiveAccount(null, OPUS));
  assert.equal(again.value.name, 'soon');
  assert.equal(again.lines.filter(l => l.includes('Refresh routing')).length, 0, 'no flapping');
});

test('new sessions are placed on the nearest window too, ahead of spreading load', () => {
  const am = mgr('nearest');
  const [fresh, soon] = am.accounts;
  win(fresh, 0.05, 4.5);
  win(soon, 0.6, 0.5);
  soon.inFlight = 3; // busier, and still chosen
  assert.equal(am._pickLeastLoadedEven(null, OPUS).name, 'soon');
});

test('off (the default): the 5h window does not decide, the existing order does', () => {
  const am = mgr(undefined);
  const [fresh, soon] = am.accounts;
  win(fresh, 0.05, 4.5);
  win(soon, 0.6, 0.5);
  am._setCurrent(fresh);
  assert.equal(quiet(() => am.getActiveAccount(null, OPUS)).value.name, 'fresh');
  assert.equal(am.expiryRouting.refresh, 'off');
});

test('quota summary: next_refresh names the soonest usable reset; fiveHour carries windowStart', () => {
  const am = mgr('nearest', ['a', 'b', 'spent']);
  const [a, b, spent] = am.accounts;
  win(a, 0.2, 2);
  win(b, 0.9, 1);
  win(spent, 0.1, 0.25);
  spent.quota.unified7d = 1; // its refresh buys nothing this week
  const s = am.getQuotaSummary();
  assert.equal(s.next_refresh.seat, 'b');
  assert.ok(s.next_refresh.in_minutes >= 59 && s.next_refresh.in_minutes <= 61);
  const fh = s.accounts.find((/** @type {any} */ x) => x.name === 'a').buckets.fiveHour;
  assert.equal(fh.windowStart, fh.resetAt - 5 * H);
});
