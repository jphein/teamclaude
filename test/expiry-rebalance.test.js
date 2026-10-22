import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, PIN_IDLE_BREAK_MS } from '../src/account-manager.js';
import { SessionTracker } from '../src/session-tracker.js';

// JP, 2026-10-22: "teamclaude should be smart after reauth and recalculate which
// is best." The ranking stays expires-first (the band); what changes is WHEN it
// is consulted. The cursor used to stay on an eligible account until it crossed
// the switch threshold, so a seat that came back from a re-auth with the most
// expiring quota waited — and that morning the whole fleet sat on a seat with 3%
// of its week left while others held 70%.

const H = 3600_000;
const OPUS = 'claude-opus-5-5';

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 24 * H };
}

/** Weekly `used` (0..1) resetting `hours` from now, with a quiet 5h window. */
function seat(am, i, used, hours) {
  const q = am.accounts[i].quota;
  q.unified7d = used;
  q.unified7dReset = Date.now() + hours * H;
  q.unified5h = 0.05;
  q.unified5hReset = Date.now() + 2 * H;
}

function mgr({ names = ['a', 'b', 'c'], expiryRouting = { enabled: true, tolerance: 1.2, rebalance: true }, ...opts } = {}) {
  return new AccountManager(names.map(oauth), 0.99, { expiryRouting, ...opts });
}

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { return { value: fn(), lines }; } finally { console.log = orig; }
}

test('a seat back from re-auth with the most expiring quota takes the cursor on the next request', () => {
  const am = mgr();
  seat(am, 0, 0.30, 110);           // 70% left over ~4.5 days
  seat(am, 1, 0.84, 11);            // 16% left, gone tonight: the most pressing
  seat(am, 2, 0.40, 100);
  am.accounts[1].status = 'error';  // needs a login
  am._setCurrent(am.accounts[0]);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');

  am.accounts[1].status = 'active'; // re-authed
  const { value, lines } = captureLog(() => am.getActiveAccount(null, OPUS));
  assert.equal(value.name, 'b');
  assert.equal(am.accounts[am.currentIndex].name, 'b', 'the cursor moved, so new sessions land there too');
  const decision = lines.filter(l => l.includes('Rebalanced'));
  assert.equal(decision.length, 1, 'one decision line per rebalance');
  assert.match(decision[0], /"a" → "b": out of the expiry band/);
});

test('the cursor does not stay on the fullest seat while others hold far more expiring quota', () => {
  // The perturbation JP's lead asked for: pin the cursor to the fullest seat and
  // it must be moved off. Before this change it stayed until 99%.
  const am = mgr();
  seat(am, 0, 0.97, 26);            // 3% left over a day
  seat(am, 1, 0.30, 85);
  seat(am, 2, 0.42, 80);
  am._setCurrent(am.accounts[0]);
  const { value } = captureLog(() => am.getActiveAccount(null, OPUS));
  assert.notEqual(value.name, 'a');
});

test('inside the band the cursor stays: the tolerance is the hysteresis', () => {
  const am = mgr();
  seat(am, 0, 0.30, 110);           // 0.70 / 110h
  seat(am, 1, 0.25, 110);           // 0.75 / 110h: better, but within 1.2×
  seat(am, 2, 0.50, 200);
  am._setCurrent(am.accounts[0]);
  const { value, lines } = captureLog(() => am.getActiveAccount(null, OPUS));
  assert.equal(value.name, 'a');
  assert.equal(lines.filter(l => l.includes('Rebalanced')).length, 0);
});

test('an unknown pressure never moves the cursor', () => {
  const am = mgr();
  seat(am, 1, 0.84, 11);
  seat(am, 2, 0.30, 100);
  am._setCurrent(am.accounts[0]);   // never read: no weekly at all
  assert.equal(captureLog(() => am.getActiveAccount(null, OPUS)).value.name, 'a');
});

test('with expiry routing off, preemption off, or rebalance not literally true, nothing rebalances', () => {
  for (const expiryRouting of [{ enabled: false, rebalance: true }, { enabled: true, tolerance: 1.2, preempt: false, rebalance: true },
    { enabled: true, tolerance: 1.2 }, { enabled: true, tolerance: 1.2, rebalance: 'true' }]) {
    const am = mgr({ expiryRouting });
    seat(am, 0, 0.97, 26);
    seat(am, 1, 0.30, 85);
    seat(am, 2, 0.42, 80);
    am._setCurrent(am.accounts[0]);
    assert.equal(captureLog(() => am.getActiveAccount(null, OPUS)).value.name, 'a', JSON.stringify(expiryRouting));
  }
});

test('a 5h reset never lands the fleet on a seat at the weekly threshold, nor on one outside the band', () => {
  // The path that put everyone on claude@ (97% weekly) at a 5h reset: it only
  // switches to an account that is available AND in the band.
  for (const used of [0.995, 0.97]) {
    const am = mgr();
    seat(am, 0, 0.30, 110);
    seat(am, 1, 0.35, 105);
    seat(am, 2, used, 26);            // its weekly resets soonest of all
    am.accounts[2].sessionResetPending = true;
    am._setCurrent(am.accounts[0]);
    const { value } = captureLog(() => am.getActiveAccount(new Set(), OPUS));
    assert.notEqual(value.name, 'c', `weekly ${used}`);
    assert.notEqual(am.accounts[am.currentIndex].name, 'c', `weekly ${used}`);
  }
});

test('a pinned session moves off an out-of-band seat only at an idle break', () => {
  let now = Date.now();
  const tracker = new SessionTracker({ now: () => now });
  const am = mgr({ distributeSessions: true, sessionTracker: tracker });
  seat(am, 0, 0.97, 26);            // the pin's seat, now the worst choice
  seat(am, 1, 0.30, 85);
  seat(am, 2, 0.42, 80);
  am.recordSession('s1', 0, OPUS);  // pinned to a; its last request just ended

  now += 60_000;                    // a minute later: mid-conversation, cache warm
  assert.equal(captureLog(() => am.getActiveAccount(null, OPUS, null, 's1')).value.name, 'a');

  now += PIN_IDLE_BREAK_MS;         // idle past the cache's lifetime
  const { value, lines } = captureLog(() => am.getActiveAccount(null, OPUS, null, 's1'));
  assert.notEqual(value.name, 'a');
  assert.equal(lines.filter(l => l.includes('Rebalanced an idle session')).length, 1);
});

test('a retry inside one request never rebalances the fleet onto a worse seat', () => {
  // b is the band's best but this request already failed on it. Moving the
  // cursor to c (out of band too) would be undone by the next request.
  const am = mgr();
  seat(am, 0, 0.97, 26);            // current, out of band
  seat(am, 1, 0.84, 11);            // the band
  seat(am, 2, 0.40, 300);           // far out of band
  am._setCurrent(am.accounts[0]);
  const { lines } = captureLog(() => am.getActiveAccount(new Set([1]), OPUS));
  assert.equal(lines.filter(l => l.includes('Rebalanced')).length, 0);
  assert.equal(am.accounts[am.currentIndex].name, 'a', 'the fleet cursor stays for the next first attempt to decide');
});

// ── review fixes (spyglass-ba, PR #36) ──────────────────────────────────────

const codex = name => ({ ...oauth(name), provider: 'codex', accountId: 'acct-' + name });

test('a Codex account in the fleet does not turn rebalancing off', () => {
  // The first-attempt gate once read the provider-augmented exclusions, which
  // always carry the other fleet's accounts.
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c'), codex('x')], 0.99,
    { expiryRouting: { enabled: true, tolerance: 1.2, rebalance: true } });
  seat(am, 0, 0.97, 26);
  seat(am, 1, 0.30, 85);
  seat(am, 2, 0.42, 80);
  am._setCurrent(am.accounts[0]);
  const { value, lines } = captureLog(() => am.getActiveAccount(null, OPUS));
  assert.notEqual(value.name, 'a');
  assert.equal(lines.filter(l => l.includes('Rebalanced')).length, 1);
});

test("an operator's switch holds against rebalancing until the account cannot serve", () => {
  const am = mgr();
  seat(am, 0, 0.97, 26);            // the worst choice, picked by hand
  seat(am, 1, 0.30, 85);
  seat(am, 2, 0.42, 80);
  am.setCurrentAccount(0);
  const held = captureLog(() => am.getActiveAccount(null, OPUS));
  assert.equal(held.value.name, 'a');
  assert.equal(held.lines.filter(l => l.includes('Rebalanced')).length, 0);
  am.accounts[0].quota.unified7d = 0.995;  // now past the switch threshold
  assert.notEqual(captureLog(() => am.getActiveAccount(null, OPUS)).value.name, 'a');
  assert.equal(am._manualHold, null, 'leaving the held account releases the hold');
});

test("a Codex walk leaves the Anthropic fleet's hold where it is", () => {
  const am = new AccountManager([oauth('a'), oauth('b'), codex('x')], 0.99,
    { expiryRouting: { enabled: true, tolerance: 1.2, rebalance: true } });
  seat(am, 0, 0.97, 26);
  seat(am, 1, 0.30, 85);
  am.setCurrentAccount(0);
  captureLog(() => am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex'));
  assert.equal(am._manualHold, 0);
  assert.equal(captureLog(() => am.getActiveAccount(null, OPUS)).value.name, 'a');
});

test('removing an account remaps the hold to the same account', () => {
  const am = mgr({ names: ['a', 'b', 'c', 'd'] });
  am.setCurrentAccount(3);
  am.removeAccount(1);
  assert.equal(am.accounts[am._manualHold].name, 'd');
  am.removeAccount(am._manualHold);
  assert.equal(am._manualHold, null, 'the held account itself removed');
});

test('a pin with another request still in flight is not at a break, however long since it was routed', () => {
  let now = Date.now();
  const tracker = new SessionTracker({ now: () => now });
  const am = mgr({ distributeSessions: true, sessionTracker: tracker });
  seat(am, 0, 0.97, 26);
  seat(am, 1, 0.30, 85);
  seat(am, 2, 0.42, 80);
  am.recordSession('s1', 0, OPUS);
  tracker.beginRequest('s1', now);  // a long stream still running
  now += PIN_IDLE_BREAK_MS + 60_000;
  tracker.beginRequest('s1', now);  // this request
  assert.equal(captureLog(() => am.getActiveAccount(null, OPUS, null, 's1')).value.name, 'a');
});

test('the seat a rebalance left is recorded so a hop in the same request cannot hand traffic back', () => {
  const am = mgr();
  seat(am, 0, 0.97, 26);
  seat(am, 1, 0.30, 85);
  seat(am, 2, 0.42, 80);
  am._setCurrent(am.accounts[0]);
  const decision = {};
  captureLog(() => am.getActiveAccount(null, OPUS, null, null, undefined, decision));
  assert.ok(decision.rolledOff?.has(0));
});
