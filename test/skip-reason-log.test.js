// When selection drops the current account, the only thing the journal used to
// show was a bare "Switched to account X" — which is indistinguishable between
// "quota spent", "throttled" and "this model's family bucket is spent". On
// 2026-08-20 that cost an evening: claude2 read 95%/active on the dashboard and
// kept losing the manual pin, because ONE background session on a different
// model was being skipped for its Fable weekly bucket. These tests pin the
// diagnostic line that names the model, the session and the failing bucket.
//
// Diagnostic only: _logSkipReason must never influence which account is picked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

/** Run `fn` with console.log captured, returning the emitted lines. */
function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

/** Two accounts: `spent` has its Fable weekly bucket exhausted, `fresh` is idle. */
function managerWithSpentFable() {
  const am = new AccountManager([
    { name: 'spent', type: 'apikey', apiKey: 'k1' },
    { name: 'fresh', type: 'apikey', apiKey: 'k2' },
  ], 0.99);
  Object.assign(am.accounts[0].quota, { unified5h: 0.7, unified7d: 0.95, unified7dFable: 1 });
  Object.assign(am.accounts[1].quota, { unified5h: 0, unified7d: 0.1, unified7dFable: 0.1 });
  am.currentIndex = 0;
  return am;
}

test('a Fable skip names the account, model, session and the failing bucket', () => {
  const am = managerWithSpentFable();
  const lines = captureLog(() =>
    am.getActiveAccount(null, 'claude-fable-5', null, '822781c5-8485-485f-8f7f-eb28445e7970'));
  const skip = lines.find(l => l.includes('Skipping'));
  assert.ok(skip, `no skip line emitted; got: ${JSON.stringify(lines)}`);
  assert.match(skip, /"spent"/);
  assert.match(skip, /claude-fable-5/);
  assert.match(skip, /session 822781c5/);          // truncated, not the whole id
  assert.match(skip, /unified7dFable bucket 100% >= 99%/);
});

test('the same account is not re-logged within the throttle window', () => {
  const am = managerWithSpentFable();
  const lines = captureLog(() => {
    for (let i = 0; i < 5; i++) {
      am.currentIndex = 0;                          // re-pin so each call re-skips
      am.getActiveAccount(null, 'claude-fable-5', null, 'sess-1234');
    }
  });
  assert.equal(lines.filter(l => l.includes('Skipping')).length, 1);
});

test('an Opus request past the same account logs nothing and keeps it selected', () => {
  const am = managerWithSpentFable();
  const lines = captureLog(() => {
    const picked = am.getActiveAccount(null, 'claude-opus-5', null, 'sess-1234');
    // The spent Fable bucket must not bar a model it does not govern.
    assert.equal(picked.name, 'spent');
  });
  assert.deepEqual(lines.filter(l => l.includes('Skipping')), []);
});

test('a throttled account reports the hold, not a quota bucket', () => {
  const am = managerWithSpentFable();
  am.accounts[0].quota.unified7dFable = 0.1;        // family bucket is fine
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + 374_000;
  const lines = captureLog(() => am.getActiveAccount(null, 'claude-opus-5', null, 'sess-1234'));
  const skip = lines.find(l => l.includes('Skipping'));
  assert.ok(skip, 'expected a skip line for the throttled account');
  assert.match(skip, /throttled until/);
});

test('logging never changes which account selection returns', () => {
  const quiet = managerWithSpentFable();
  quiet._logSkipReason = () => {};                  // silence the diagnostic
  const loud = managerWithSpentFable();
  const a = quiet.getActiveAccount(null, 'claude-fable-5', null, 'sess-1234');
  const b = captureLog(() => loud.getActiveAccount(null, 'claude-fable-5', null, 'sess-1234'));
  const picked = loud.accounts[loud.currentIndex];
  assert.equal(a.name, 'fresh');
  assert.equal(picked.name, 'fresh');
  assert.ok(b.some(l => l.includes('Skipping')));   // the loud one did log
});
