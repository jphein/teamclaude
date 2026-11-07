import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const H = 3_600_000;
function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: `token-${name}`, rateLimitTier: 'default_claude_max_5x', ...extra };
}

test('quota summary counts live seats and names when the next barred seat returns', () => {
  const now = Date.now();
  const am = new AccountManager([
    oauth('live'),
    oauth('held'),
    oauth('capped', { maxUsage: { unified5h: 0.6, unified7d: 0.5 } }),
    oauth('off', { disabled: true }),
  ], { default: 0.93, unified5h: 1, unified7d: 1 });
  const [live, held, capped] = am.accounts;
  Object.assign(live.quota, { unified5h: 0.2, unified5hReset: now + 2 * H, unified7d: 0.3, unified7dReset: now + 90 * H });
  // A 429 hold that ends in 1 h on a seat whose week is spent for 50 h: it is
  // back when the LATER of the two ends, not when the hold lifts.
  Object.assign(held.quota, { unified5h: 0, unified5hReset: now + 4 * H, unified7d: 1, unified7dReset: now + 50 * H });
  held.status = 'throttled'; held.rateLimitedUntil = now + H; held.throttledAt = now;
  // Over its own 50% weekly cap though under the fleet's 100%.
  Object.assign(capped.quota, { unified5h: 0.1, unified5hReset: now + 3 * H, unified7d: 0.55, unified7dReset: now + 30 * H });

  const s = am.getQuotaSummary();
  assert.equal(s.live_seats, 1);
  assert.equal(s.next_reset, new Date(now + 30 * H).toISOString());
  assert.ok(Array.isArray(s.accounts) && s.aggregate, 'the existing summary is still there');
});

test('a dry pool reports zero live seats and the soonest return', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b')], { default: 0.93, unified5h: 1, unified7d: 1 });
  Object.assign(am.accounts[0].quota, { unified5h: 1, unified5hReset: now + 2 * H, unified7d: 0.4, unified7dReset: now + 80 * H });
  Object.assign(am.accounts[1].quota, { unified5h: 1, unified5hReset: now + H, unified7d: 1, unified7dReset: now + 70 * H });
  const s = am.getQuotaSummary();
  assert.equal(s.live_seats, 0);
  assert.equal(s.next_reset, new Date(now + 2 * H).toISOString());
});

test('nothing barred on a clock gives a null next_reset', () => {
  const am = new AccountManager([oauth('a', { disabled: true })], 0.93);
  const s = am.getQuotaSummary();
  assert.equal(s.live_seats, 0);
  assert.equal(s.next_reset, null);
});
