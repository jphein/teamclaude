import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// ── toggle default & construction ────────────────────────────

test('load balancing is off by default (sticky account)', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am.loadBalance, false);
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount().name, 'a');
  assert.equal(am.getActiveAccount().name, 'a'); // stays put — no spreading
});

test('load balancing can be enabled via constructor options', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { loadBalance: true });
  assert.equal(am.loadBalance, true);
});

// ── in-flight accounting ─────────────────────────────────────

test('acquire increments in-flight and returns a release fn', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const rel = am.acquire(0);
  assert.equal(am.accounts[0].inFlight, 1);
  rel();
  assert.equal(am.accounts[0].inFlight, 0);
});

test('release never drops in-flight below zero', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.release(0);
  assert.equal(am.accounts[0].inFlight, 0);
});

test('the release fn is idempotent', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const rel = am.acquire(0);
  rel();
  rel();
  assert.equal(am.accounts[0].inFlight, 0);
});

// ── least-in-flight selection ────────────────────────────────

test('load balancing selects the account with the fewest in-flight requests', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, { loadBalance: true });
  am.accounts[0].inFlight = 3;
  am.accounts[1].inFlight = 1;
  am.accounts[2].inFlight = 5;
  assert.equal(am.getActiveAccount().name, 'b');
});

test('load balancing skips unavailable accounts even if least loaded', () => {
  const am = new AccountManager([oauth('a', { disabled: true }), oauth('b')], 0.98, { loadBalance: true });
  am.accounts[0].inFlight = 0; // least loaded but disabled
  am.accounts[1].inFlight = 4;
  assert.equal(am.getActiveAccount().name, 'b');
});

test('load balancing breaks in-flight ties by lower 5h utilization', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { loadBalance: true });
  am.accounts[0].inFlight = 2;
  am.accounts[0].quota.unified5h = 0.8;
  am.accounts[1].inFlight = 2;
  am.accounts[1].quota.unified5h = 0.2;
  assert.equal(am.getActiveAccount().name, 'b');
});

// ── burst-vs-quota classification ────────────────────────────

test('a 429 while under quota is counted as a burst hit', () => {
  const am = new AccountManager([oauth('a')], 0.97);
  am.accounts[0].quota.unified5h = 0.10; // well under threshold
  am.markRateLimited(0, 60);
  assert.equal(am.accounts[0].stats.burstHits, 1);
  assert.equal(am.accounts[0].stats.rateLimitHits, 1);
});

test('a 429 at/over quota threshold is NOT a burst hit', () => {
  const am = new AccountManager([oauth('a')], 0.97);
  am.accounts[0].quota.unified5h = 0.98; // over threshold => genuine exhaustion
  am.markRateLimited(0, 300);
  assert.equal(am.accounts[0].stats.burstHits, 0);
  assert.equal(am.accounts[0].stats.rateLimitHits, 1);
});

test('markRateLimited records the retry-after and a timestamp', () => {
  const am = new AccountManager([oauth('a')], 0.97);
  am.markRateLimited(0, 42);
  assert.equal(am.accounts[0].stats.lastRetryAfter, 42);
  assert.ok(am.accounts[0].stats.lastRateLimitedAt);
});

// ── status exposure (feeds both dashboards) ──────────────────

test('getStatus exposes loadBalance, inFlight and stats', () => {
  const am = new AccountManager([oauth('a')], 0.98, { loadBalance: true });
  am.acquire(0);
  am.markRateLimited(0, 30);
  const s = am.getStatus();
  assert.equal(s.loadBalance, true);
  assert.equal(s.accounts[0].inFlight, 1);
  assert.equal(s.accounts[0].stats.rateLimitHits, 1);
});
