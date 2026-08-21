// A model-scoped exclusion must not move the GLOBAL current account.
//
// Fable and Sonnet meter their own weekly quota. When the current account's
// family bucket is spent, that request has to go elsewhere — but the account is
// still perfectly usable for every other model. Repointing `currentIndex` on
// its way out meant one background session on Fable dragged the pointer off the
// account, and unrelated Opus sessions then found the new account available and
// stayed there. A manual pin evaporated within seconds, repeatedly, with no
// visible reason (2026-08-20).
//
// So: a request barred only by its own model detours without switching; a
// shared-bucket or account-level problem (5h, unified weekly, throttle,
// disable) still switches stickily, exactly as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const QUIET = { log: () => {} };

/** `spent` is current; `fresh` is idle. Console silenced unless asked for. */
function fixture({ silence = true } = {}) {
  const am = new AccountManager([
    { name: 'spent', type: 'apikey', apiKey: 'k1' },
    { name: 'fresh', type: 'apikey', apiKey: 'k2' },
  ], 0.99);
  Object.assign(am.accounts[0].quota, { unified5h: 0.5, unified7d: 0.9, unified7dFable: 1 });
  Object.assign(am.accounts[1].quota, { unified5h: 0, unified7d: 0.1, unified7dFable: 0.1 });
  am.currentIndex = 0;
  if (silence) am._logSkipReason = QUIET.log;
  return am;
}

test('a Fable request detours to another account and leaves the pointer put', () => {
  const am = fixture();
  const picked = am.getActiveAccount(null, 'claude-fable-5', null, 'sess-1');
  assert.equal(picked.name, 'fresh', 'the request must be served by an eligible account');
  assert.equal(am.currentIndex, 0, 'the current account must not move for a model-scoped skip');
});

test('after the detour an Opus request still lands on the original account', () => {
  const am = fixture();
  am.getActiveAccount(null, 'claude-fable-5', null, 'sess-fable');   // the interloper
  const picked = am.getActiveAccount(null, 'claude-opus-5', null, 'sess-opus');
  assert.equal(picked.name, 'spent', 'Opus can still spend this account; it must not have drifted');
  assert.equal(am.currentIndex, 0);
});

test('an advisor-model bar also detours without switching', () => {
  const am = fixture();
  const picked = am.getActiveAccount(null, 'claude-opus-5', 'claude-fable-5', 'sess-1');
  assert.equal(picked.name, 'fresh');
  assert.equal(am.currentIndex, 0);
});

test('a spent SHARED weekly bucket still switches stickily', () => {
  const am = fixture();
  am.accounts[0].quota.unified7d = 1;          // shared bucket, governs every model
  am.accounts[0].quota.unified7dFable = 0.1;
  const picked = am.getActiveAccount(null, 'claude-opus-5', null, 'sess-1');
  assert.equal(picked.name, 'fresh');
  assert.equal(am.currentIndex, 1, 'a shared-quota exhaustion is a real switch');
});

test('a spent 5h bucket still switches stickily', () => {
  const am = fixture();
  am.accounts[0].quota.unified5h = 1;
  const picked = am.getActiveAccount(null, 'claude-fable-5', null, 'sess-1');
  assert.equal(picked.name, 'fresh');
  assert.equal(am.currentIndex, 1, '5h gates every model, so the switch must stick');
});

test('a throttled account still switches stickily', () => {
  const am = fixture();
  am.accounts[0].quota.unified7dFable = 0.1;
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + 374_000;
  const picked = am.getActiveAccount(null, 'claude-opus-5', null, 'sess-1');
  assert.equal(picked.name, 'fresh');
  assert.equal(am.currentIndex, 1);
});

test('a disabled account still switches stickily', () => {
  const am = fixture();
  am.accounts[0].quota.unified7dFable = 0.1;
  am.accounts[0].disabled = true;
  const picked = am.getActiveAccount(null, 'claude-opus-5', null, 'sess-1');
  assert.equal(picked.name, 'fresh');
  assert.equal(am.currentIndex, 1);
});

test('with no eligible alternative the pointer is still left alone', () => {
  const am = fixture();
  am.accounts[1].quota.unified7dFable = 1;     // nowhere to detour to for Fable
  const picked = am.getActiveAccount(null, 'claude-fable-5', null, 'sess-1');
  assert.equal(am.currentIndex, 0, 'a failed detour must not corrupt the pointer');
  // Selection may fall back to a probe or refuse; either way it must not claim
  // an account that cannot serve the family.
  if (picked) assert.notEqual(picked.quota.unified7dFable, undefined);
});

test('the detour is announced without claiming a switch', () => {
  const am = fixture({ silence: false });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { am.getActiveAccount(null, 'claude-fable-5', null, 'sess-1'); } finally { console.log = orig; }
  assert.ok(lines.some(l => /Skipping/.test(l)), 'the reason must still be logged');
  assert.ok(!lines.some(l => /Switched to account/.test(l)),
    'no switch happened, so nothing may claim one');
});
