import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Make an account "exhausted" so _selectNext skips it, isolating the priority sort.
function exhaust(am, idx) {
  am.accounts[idx].status = 'exhausted';
}

test('default priority (all 0) preserves the existing selection (first available)', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  // No quota known anywhere → weeklyReset is -Infinity for all, ties on priority 0,
  // so the first available account is chosen, matching pre-priority behavior.
  const next = am._selectNext();
  assert.equal(next.name, 'a');
});

test('lower priority value is preferred over config order', () => {
  const am = new AccountManager([
    oauth('a', { priority: 5 }),
    oauth('b', { priority: 1 }),
    oauth('c', { priority: 3 }),
  ], 0.98);
  assert.equal(am._selectNext().name, 'b');
});

test('within the same priority, the existing heuristic breaks the tie', () => {
  const am = new AccountManager([
    oauth('a', { priority: 0 }),
    oauth('b', { priority: 0 }),
  ], 0.98);
  // Give both a known weekly reset; the sooner-expiring one should win the tie.
  am.accounts[0].quota.unified7dReset = 5000;
  am.accounts[1].quota.unified7dReset = 1000;
  assert.equal(am._selectNext().name, 'b');
});

test('priority is respected even when a higher-priority account is also available', () => {
  const am = new AccountManager([
    oauth('a', { priority: 0 }),
    oauth('b', { priority: -1 }), // most preferred
    oauth('c', { priority: 10 }),
  ], 0.98);
  assert.equal(am._selectNext().name, 'b');
});

test('exhausted highest-priority account is skipped, next priority wins', () => {
  const am = new AccountManager([
    oauth('a', { priority: 1 }),
    oauth('b', { priority: 2 }),
  ], 0.98);
  exhaust(am, 0);
  assert.equal(am._selectNext().name, 'b');
});

test('getActiveAccount preempts a healthy current account for a higher-priority one', () => {
  const am = new AccountManager([oauth('a', { priority: 0 }), oauth('b', { priority: 1 })], 0.98);
  am.currentIndex = 1; // currently on the lower-priority account
  assert.equal(am.getActiveAccount().name, 'a');
  assert.equal(am.currentIndex, 0);
});

test('getActiveAccount stays sticky within the same priority tier (no thrash)', () => {
  const am = new AccountManager([oauth('a', { priority: 0 }), oauth('b', { priority: 0 })], 0.98);
  am.currentIndex = 0;
  // b has a sooner weekly reset, but same priority → must NOT switch away from a.
  am.accounts[0].quota.unified7dReset = 5000;
  am.accounts[1].quota.unified7dReset = 1000;
  assert.equal(am.getActiveAccount().name, 'a');
  assert.equal(am.currentIndex, 0);
});

test('common case: all-equal priority leaves getActiveAccount on the healthy current account', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  am.currentIndex = 2;
  assert.equal(am.getActiveAccount().name, 'c'); // unchanged — no preemption when priorities tie
});

// ── selectActiveAccount (daemon-launch up-front selection) ───────────────────

test('selectActiveAccount picks the soonest-resetting weekly window, not index 0', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  // All same priority and available; b's weekly resets soonest → spend it first.
  am.accounts[0].quota.unified7d = 0.5; am.accounts[0].quota.unified7dReset = now + 5 * 86400_000;
  am.accounts[1].quota.unified7d = 0.5; am.accounts[1].quota.unified7dReset = now + 1 * 86400_000;
  am.accounts[2].quota.unified7d = 0.5; am.accounts[2].quota.unified7dReset = now + 3 * 86400_000;
  const chosen = am.selectActiveAccount();
  assert.equal(chosen.name, 'b');
  assert.equal(am.currentIndex, 1); // currentIndex actually moved off 0
});

test('selectActiveAccount honors priority over the weekly heuristic', () => {
  const now = Date.now();
  const am = new AccountManager([
    oauth('a', { priority: 0 }),
    oauth('b', { priority: 1 }), // higher-priority value = less preferred
  ], 0.98);
  // b resets sooner, but a has the better (lower) priority value → a wins.
  am.accounts[0].quota.unified7d = 0.5; am.accounts[0].quota.unified7dReset = now + 5 * 86400_000;
  am.accounts[1].quota.unified7d = 0.5; am.accounts[1].quota.unified7dReset = now + 1 * 86400_000;
  assert.equal(am.selectActiveAccount().name, 'a');
});

test('selectActiveAccount skips an account already over the weekly threshold', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.accounts[0].quota.unified7d = 0.99; am.accounts[0].quota.unified7dReset = now + 86400_000; // near-exhausted
  am.accounts[1].quota.unified7d = 0.10; am.accounts[1].quota.unified7dReset = now + 5 * 86400_000;
  assert.equal(am.selectActiveAccount().name, 'b');
});

test('selectActiveAccount restores onto the best account after an export → restore cycle', () => {
  const now = Date.now();
  const am1 = new AccountManager([
    oauth('a', { accountUuid: 'p1' }),
    oauth('b', { accountUuid: 'p2' }),
  ], 0.98);
  am1.accounts[0].quota.unified7d = 0.8; am1.accounts[0].quota.unified7dReset = now + 6 * 86400_000;
  am1.accounts[1].quota.unified7d = 0.2; am1.accounts[1].quota.unified7dReset = now + 2 * 86400_000;

  const am2 = new AccountManager([
    oauth('a', { accountUuid: 'p1' }),
    oauth('b', { accountUuid: 'p2' }),
  ], 0.98);
  am2.restoreQuotaState(am1.exportQuotaState());
  // b's weekly resets sooner → start there, mirroring a real daemon launch.
  assert.equal(am2.selectActiveAccount().name, 'b');
});

test('selectActiveAccount leaves current account when none are available', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.accounts[0].status = 'exhausted';
  am.accounts[1].disabled = true;
  am.currentIndex = 1;
  const chosen = am.selectActiveAccount();
  assert.equal(chosen.name, 'b');   // falls back to the existing current account
  assert.equal(am.currentIndex, 1); // unchanged
});

// ── strict list order: a renewed higher account takes traffic back (JP, 2026-10-11) ──
// "Always use the top-most account that has quota; when a higher one renews
// (its 5h OR its 7d window resets), the next request goes back to it."
// priority = list position; a spent window keeps the account out until its
// reset passes, then _clearExpiredQuotas clears it and _preemptedBy moves the
// fleet back up on the very next selection.

const OPUS = 'claude-opus-5';

test('a higher-priority account whose 5h window renews takes traffic back on the next request', () => {
  const am = new AccountManager([oauth('top', { priority: 0 }), oauth('next', { priority: 1 })], 0.98);
  am.accounts[0].quota.unified5h = 1;                       // top spent its 5h window...
  am.accounts[0].quota.unified5hReset = Date.now() + 60_000; // ...resetting in a minute
  assert.equal(am.getActiveAccount(null, OPUS).name, 'next', 'spent top account is skipped');
  assert.equal(am.currentIndex, 1);

  am.accounts[0].quota.unified5hReset = Date.now() - 1;     // the 5h window renews
  assert.equal(am.getActiveAccount(null, OPUS).name, 'top', 'renewed top account wins again');
  assert.equal(am.currentIndex, 0, 'and the fleet stays there (sticky on the top)');
});

test('a higher-priority account whose 7d window renews takes traffic back on the next request', () => {
  const am = new AccountManager([oauth('top', { priority: 0 }), oauth('next', { priority: 1 })], 0.98);
  am.accounts[0].quota.unified7d = 1;
  am.accounts[0].quota.unified7dReset = Date.now() + 3600_000;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'next');

  am.accounts[0].quota.unified7dReset = Date.now() - 1;     // the weekly window renews
  assert.equal(am.getActiveAccount(null, OPUS).name, 'top');
  assert.equal(am.currentIndex, 0);
});

test('with three accounts, traffic always lands on the top-most one with quota', () => {
  const am = new AccountManager([
    oauth('p0', { priority: 0 }), oauth('p1', { priority: 1 }), oauth('p2', { priority: 2 }),
  ], 0.98);
  const spend5h = (i, ms) => { am.accounts[i].quota.unified5h = 1; am.accounts[i].quota.unified5hReset = Date.now() + ms; };
  spend5h(0, 60_000); spend5h(1, 120_000);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'p2');
  am.accounts[1].quota.unified5hReset = Date.now() - 1;     // the middle one renews first
  assert.equal(am.getActiveAccount(null, OPUS).name, 'p1', 'moves up to the renewed middle, not stuck at the bottom');
  am.accounts[0].quota.unified5hReset = Date.now() - 1;     // then the top renews
  assert.equal(am.getActiveAccount(null, OPUS).name, 'p0');
});

test('a session pinned to a lower account moves back to the renewed higher one (distributeSessions on)', () => {
  const am = new AccountManager([oauth('top', { priority: 0 }), oauth('next', { priority: 1 })], 0.98, { distributeSessions: true });
  am.accounts[0].quota.unified5h = 1;
  am.accounts[0].quota.unified5hReset = Date.now() + 60_000;
  const first = am.getActiveAccount(null, OPUS, null, 'sess-1');
  assert.equal(first.name, 'next');
  am.recordSession('sess-1', first.index, OPUS);            // the session is now pinned to "next"

  am.accounts[0].quota.unified5hReset = Date.now() - 1;
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'top', 'the pin yields to the renewed higher account');
});
