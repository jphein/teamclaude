// The automatic banked-reset rules (src/reset-rules.js) and the redeemer's rule spend
// (ClaudeResetRedeemer.redeemByRule). Nothing reaches the network: every fetch is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ruleFor, WORK_BLOCK_IDLE_MS } from '../src/reset-rules.js';
import { AccountManager } from '../src/account-manager.js';
import { parseResetStatus, ClaudeResetRedeemer, RULE_SPACING_MS } from '../src/claude-resets.js';

const H = 3600_000, DAY = 24 * H;
const NOW = Date.parse('2026-12-04T17:00:00Z');
const WEEKLY = ['five_hour', 'seven_day', 'seven_day_overage_included'];
const FIVE = ['five_hour', 'seven_day_overage_included'];
const g = (over = {}) => ({ next: true, usable: true, clearsWeekly: false, clears: FIVE, resetsLeft: 1, endsAt: NOW + 90 * DAY, ...over });
const wk = (over = {}) => g({ clearsWeekly: true, clears: WEEKLY, endsAt: NOW + 6 * DAY, ...over });
const kept = (...grants) => ({ eligible: true, grants });
const seat = (q) => ({ quota: { unified5h: 0.2, unified5hReset: NOW + 2 * H, unified7d: 0.65, unified7dReset: NOW + 7 * DAY, ...q } });

// ---------- expiry rule
test('expiry: a weekly reset expiring before the seat\'s week resets fires at a work-block start once weekly >= 60%', () => {
  const r = ruleFor(seat({}), { now: NOW, kept: kept(wk()), idleMs: WORK_BLOCK_IDLE_MS });
  assert.equal(r?.rule, 'expiry');
  assert.equal(ruleFor(seat({ unified7d: 0.6 }), { now: NOW, kept: kept(wk()), idleMs: null })?.rule, 'expiry', 'exactly 60%, first use ever');
});

test('expiry: not mid-block, not under 60%, not when the week resets first, not when the next grant is not the weekly one', () => {
  const k = kept(wk());
  assert.equal(ruleFor(seat({}), { now: NOW, kept: k, idleMs: WORK_BLOCK_IDLE_MS - 1 }), null, 'mid work block');
  assert.equal(ruleFor(seat({ unified7d: 0.59 }), { now: NOW, kept: k, idleMs: DAY }), null, 'under 60%');
  assert.equal(ruleFor(seat({ unified7dReset: NOW + 5 * DAY }), { now: NOW, kept: k, idleMs: DAY }), null, 'the week resets before the grant expires');
  assert.equal(ruleFor(seat({ unified7dReset: NOW + 6 * DAY }), { now: NOW, kept: k, idleMs: DAY }), null, 'expiry equal to the reset is not before it');
  assert.equal(ruleFor(seat({ unified7dReset: null }), { now: NOW, kept: k, idleMs: DAY }), null, 'unknown week reset: no');
  assert.equal(ruleFor(seat({}), { now: NOW, kept: kept(wk({ next: false }), g()), idleMs: DAY }), null, 'the next grant is 5h-only');
  assert.equal(ruleFor(seat({}), { now: NOW, kept: kept(wk({ usable: false })), idleMs: DAY }), null, 'not usable now');
  assert.equal(ruleFor(seat({}), { now: NOW, kept: { ...kept(wk()), eligible: false }, idleMs: DAY }), null, 'ineligible');
  assert.equal(ruleFor(seat({}), { now: NOW, kept: null, idleMs: DAY }), null, 'never probed');
});

// ---------- five-hour rule
test('five-hour: at the 5-hour wall with weekly room while the pool waits on 5-hour walls, a 5h-only reset fires', () => {
  const r = ruleFor(seat({ unified5h: 1, unified7d: 0.3 }), { now: NOW, kept: kept(g()), idleMs: 0, pool5hRemaining: 0.19 });
  assert.equal(r?.rule, 'five-hour');
});

test('five-hour: never burns a weekly-clearing next grant; not at 70% weekly, not with pool 5h at 20%, not off the wall', () => {
  const base = { now: NOW, idleMs: 0, pool5hRemaining: 0.1 };
  assert.equal(ruleFor(seat({ unified5h: 1, unified7d: 0.3 }), { ...base, kept: kept(wk({ endsAt: NOW + 90 * DAY }), g({ next: false })) }), null, 'next is the weekly one: kept');
  assert.equal(ruleFor(seat({ unified5h: 1, unified7d: 0.7 }), { ...base, kept: kept(g()) }), null, 'weekly at 70%');
  assert.equal(ruleFor(seat({ unified5h: 1, unified7d: 0.3 }), { ...base, kept: kept(g()), pool5hRemaining: 0.2 }), null, 'pool 5h at 20%');
  assert.equal(ruleFor(seat({ unified5h: 1, unified7d: 0.3 }), { ...base, kept: kept(g()), pool5hRemaining: null }), null, 'pool unknown');
  assert.equal(ruleFor(seat({ unified5h: 0.97, unified7d: 0.3 }), { ...base, kept: kept(g()) }), null, 'not at the wall');
  assert.equal(ruleFor(seat({ unified5h: 1, unified5hReset: NOW - 1, unified7d: 0.3 }), { ...base, kept: kept(g()) }), null, 'a past wall');
  assert.equal(ruleFor(seat({ unified5h: 1, unified7d: 0.3 }), { ...base, kept: kept(g({ clears: ['seven_day_overage_included'] })) }), null, 'does not clear five_hour');
});

// ---------- redeemByRule (the spend)
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, orgUuid: 'org-' + name, ...extra });
const block = (over = {}, grants) => ({
  eligible: true, ineligible_reason: null, at_limit: false, exhausted: [], cooldown_until: null, next_grant_id: 'gr-week',
  grants: grants ?? [{ id: 'gr-week', resets_left: 1, clears: WEEKLY, usable_now: true, paused: false, ends_at: new Date(Date.now() + 6 * DAY).toISOString() }],
  ...over,
});
function rig({ status = () => block(), claim = () => ({ result: 'reset', resetsLeft: 0, cleared: WEEKLY, cooldownUntil: null }), config = { autoRedeemResets: true }, quota = {}, usage = {}, persist = async () => {} } = {}) {
  const u = { week: 0.65, five: 0.4, weekReset: Date.now() + 7 * DAY, ...usage };
  const am = new AccountManager([oauth('a@x.org'), oauth('b@x.org')], 0.98);
  for (const a of am.accounts) Object.assign(a.quota, { unified7d: 0.65, unified7dReset: Date.now() + 7 * DAY, ...quota });
  am.ensureTokenFresh = async () => {};
  const calls = { status: 0, claim: [], logs: [] };
  const redeemer = new ClaudeResetRedeemer(am, {
    config, log: (l) => calls.logs.push(l),
    persist: async () => { calls.persisted = (calls.persisted || 0) + 1; calls.ruleAtOnDisk = am.accounts.map(a => a.quota.claudeResetRuleAt); return persist(); },
    statusFn: async () => { calls.status++; return { reset: parseResetStatus(status(calls)), usage: { fiveHour: { utilization: u.five }, sevenDay: { utilization: calls.claim.length ? 0 : u.week, resetAt: u.weekReset } } }; },
    claimFn: async (acct, c) => { calls.claim.push([acct.name, c.grantId]); calls.ruleAtAtClaim = acct.quota.claudeResetRuleAt; return claim(); },
  });
  return { am, redeemer, calls };
}

test('redeemByRule expiry: spends the next weekly grant, logs seat + grant, reports before/after, spaces the seat 24 h', async () => {
  const { am, redeemer, calls } = rig();
  const r = await redeemer.redeemByRule(am.accounts[0], 'expiry', 'test');
  assert.equal(r.redeemed, true);
  assert.deepEqual(calls.claim, [['a@x.org', 'gr-week']]);
  assert.equal(r.grantId, 'gr-week');
  assert.equal(r.weeklyBefore, 0.65); assert.equal(r.weeklyAfter, 0);
  assert.ok(calls.logs.some(l => /Redeemed .*"a@x\.org" \(grant gr-week\)/.test(l)));
  assert.ok(Number.isFinite(am.accounts[0].quota.claudeResetRuleAt), 'spacing kept on the saved quota');
  // the fleet hold and the 24 h spacing both stop a second rule spend
  assert.match((await redeemer.redeemByRule(am.accounts[1], 'expiry')).reason, /holding off/);
  redeemer.now = () => Date.now() + 2 * H;
  assert.match((await redeemer.redeemByRule(am.accounts[0], 'expiry')).reason, /in the last 24 h/);
  redeemer.now = () => Date.now() + RULE_SPACING_MS + 2 * H;
  assert.equal(calls.claim.length, 1);
});

test('redeemByRule: switched off, unknown rule, exempt or disabled seat spends nothing and reads nothing', async () => {
  const off = rig({ config: { autoRedeemResets: false } });
  assert.match((await off.redeemer.redeemByRule(off.am.accounts[0], 'expiry')).reason, /switched off/);
  const r = rig();
  assert.match((await r.redeemer.redeemByRule(r.am.accounts[0], 'pool')).reason, /unknown rule/);
  r.am.accounts[0].autoRedeemReset = false;
  assert.match((await r.redeemer.redeemByRule(r.am.accounts[0], 'expiry')).reason, /not a seat/);
  r.am.accounts[1].disabled = true;
  assert.match((await r.redeemer.redeemByRule(r.am.accounts[1], 'expiry')).reason, /not a seat/);
  assert.equal(off.calls.status + r.calls.status, 0);
  assert.equal(off.calls.claim.length + r.calls.claim.length, 0);
});

test('redeemByRule expiry: the live read decides (under 60%, week resets first); a decline cools the seat so it is not re-read each request', async () => {
  const low = rig({ usage: { week: 0.59, five: 0 } });
  assert.equal((await low.redeemer.redeemByRule(low.am.accounts[0], 'expiry')).reason, 'weekly use is under 60%');
  assert.match((await low.redeemer.redeemByRule(low.am.accounts[0], 'expiry')).reason, /cooling down/);
  assert.equal(low.calls.status, 1);
  // the LIVE week reset decides, not the cached one (the cache says 7 days, the live read 2)
  const soon = rig({ usage: { weekReset: Date.now() + 2 * DAY } });
  assert.match((await soon.redeemer.redeemByRule(soon.am.accounts[0], 'expiry')).reason, /does not expire before/);
  assert.equal(low.calls.claim.length + soon.calls.claim.length, 0);
});

test('redeemByRule five-hour: never spends a weekly-clearing next grant; spends a 5h-only one only at a live 5-hour wall with weekly room', async () => {
  const keep = rig({ status: () => block({ at_limit: true, exhausted: ['five_hour'] }) });
  assert.match((await keep.redeemer.redeemByRule(keep.am.accounts[0], 'five-hour')).reason, /clears the weekly; kept/);
  const five = [{ id: 'gr-5h', resets_left: 1, clears: FIVE, usable_now: true, paused: false, ends_at: new Date(Date.now() + 90 * DAY).toISOString() }];
  const off = rig({ status: () => block({ next_grant_id: 'gr-5h' }, five) });
  assert.equal((await off.redeemer.redeemByRule(off.am.accounts[0], 'five-hour')).reason, 'not at its 5-hour wall');
  const full = rig({ status: () => block({ next_grant_id: 'gr-5h', at_limit: true, exhausted: ['five_hour'] }, five), usage: { week: 0.7, five: 1 } });
  assert.equal((await full.redeemer.redeemByRule(full.am.accounts[0], 'five-hour')).reason, 'its week has no room');
  const ok = rig({ status: () => block({ next_grant_id: 'gr-5h', at_limit: true, exhausted: ['five_hour'] }, five), claim: () => ({ result: 'reset', resetsLeft: 0, cleared: FIVE }), usage: { week: 0.3, five: 1 } });
  const recovered = rig({ status: () => block({ next_grant_id: 'gr-5h', at_limit: true, exhausted: ['five_hour'] }, five), usage: { week: 0.3, five: 1 } });
  assert.equal((await recovered.redeemer.redeemByRule(recovered.am.accounts[0], 'five-hour', '', { pool5h: () => 0.2 })).reason, "the pool's 5-hour headroom recovered");
  assert.equal(recovered.calls.claim.length, 0);
  const r = await ok.redeemer.redeemByRule(ok.am.accounts[0], 'five-hour', '', { pool5h: () => 0.1 });
  assert.equal(r.redeemed, true);
  assert.deepEqual(ok.calls.claim, [['a@x.org', 'gr-5h']]);
  assert.equal(r.fiveHourBefore, 1);
  assert.equal(keep.calls.claim.length + off.calls.claim.length + full.calls.claim.length, 0);
});

test('redeemByRule: a claim with no verdict still spaces the seat and holds the fleet', async () => {
  const { am, redeemer } = rig({ claim: () => ({ error: 'socket hang up' }) });
  const r = await redeemer.redeemByRule(am.accounts[0], 'expiry');
  assert.equal(r.maybeSpent, true);
  assert.ok(Number.isFinite(am.accounts[0].quota.claudeResetRuleAt));
  assert.ok(redeemer.fleetHoldUntil > Date.now());
});

// ---------- the trigger
test('onSeatRequest reports how long the seat was idle before this response', () => {
  const am = new AccountManager([oauth('a@x.org')], 0.98);
  const seen = [];
  am.onSeatRequest(({ account, idleMs }) => seen.push([account.name, idleMs]));
  const headers = new globalThis.Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600) });
  am.updateQuota(0, headers);
  am.accounts[0].usage.lastUsed = new Date(Date.now() - 45 * 60_000).toISOString();
  am.updateQuota(0, headers);
  assert.equal(seen.length, 2);
  assert.equal(seen[0][1], null, 'never used before');
  assert.ok(seen[1][1] >= 45 * 60_000 - 1000 && seen[1][1] < 46 * 60_000);
});

// ---------- xreview round 1 (reset rules)
test('the 24 h reservation is on disk before the claim; a failed save spends nothing; an upstream decline gives the day back', async () => {
  const a = rig();
  await a.redeemer.redeemByRule(a.am.accounts[0], 'expiry');
  assert.equal(a.calls.persisted, 1);
  assert.ok(Number.isFinite(a.calls.ruleAtOnDisk[0]), 'reserved when the state was written');
  assert.ok(Number.isFinite(a.calls.ruleAtAtClaim), 'and still reserved at the claim');
  const fail = rig({ persist: async () => { throw new Error('disk full'); } });
  const r = await fail.redeemer.redeemByRule(fail.am.accounts[0], 'expiry');
  assert.equal(r.reason, 'could not save the rule reservation; nothing spent');
  assert.equal(fail.calls.claim.length, 0);
  assert.equal(fail.am.accounts[0].quota.claudeResetRuleAt, undefined);
  const no = rig({ claim: () => ({ result: 'not_limited', reason: null }) });
  assert.match((await no.redeemer.redeemByRule(no.am.accounts[0], 'expiry')).reason, /upstream declined/);
  assert.equal(no.am.accounts[0].quota.claudeResetRuleAt, undefined, 'nothing spent: the day is not used');
});

test('the rule reservation is a persisted quota field (survives a restart)', () => {
  const am = new AccountManager([oauth('a@x.org')], 0.98);
  am.accounts[0].quota.claudeResetRuleAt = 12345;
  const saved = am.exportQuotaState();
  const fresh = new AccountManager([oauth('a@x.org')], 0.98);
  fresh.restoreQuotaState(saved);
  assert.equal(fresh.accounts[0].quota.claudeResetRuleAt, 12345);
});

test('switching auto-redeem off during the live read stops the claim; a failed token refresh cools the seat', async () => {
  const cfg = { autoRedeemResets: true };
  const r = rig({ config: cfg, status: () => { cfg.autoRedeemResets = false; return block(); } });
  assert.equal((await r.redeemer.redeemByRule(r.am.accounts[0], 'expiry')).reason, 'auto-redeem is switched off');
  assert.equal(r.calls.claim.length, 0);
  const t = rig();
  t.am.ensureTokenFresh = async () => { throw new Error('invalid_grant'); };
  assert.match((await t.redeemer.redeemByRule(t.am.accounts[0], 'expiry')).reason, /token refresh failed/);
  assert.match((await t.redeemer.redeemByRule(t.am.accounts[0], 'expiry')).reason, /cooling down/);
});

// ---------- xreview round 2 (reset rules)
test('checks made after the reservation save: switch off or pool recovered during persist() spends nothing and releases the day', async () => {
  const cfg = { autoRedeemResets: true };
  const a = rig({ config: cfg, persist: async () => { cfg.autoRedeemResets = false; } });
  assert.equal((await a.redeemer.redeemByRule(a.am.accounts[0], 'expiry')).reason, 'auto-redeem is switched off');
  assert.equal(a.calls.claim.length, 0);
  assert.equal(a.am.accounts[0].quota.claudeResetRuleAt, undefined);
  const five = [{ id: 'gr-5h', resets_left: 1, clears: FIVE, usable_now: true, paused: false, ends_at: new Date(Date.now() + 90 * DAY).toISOString() }];
  let pool = 0.1;
  const b = rig({ status: () => block({ next_grant_id: 'gr-5h', at_limit: true, exhausted: ['five_hour'] }, five), usage: { week: 0.3, five: 1 }, persist: async () => { pool = 0.5; } });
  assert.equal((await b.redeemer.redeemByRule(b.am.accounts[0], 'five-hour', '', { pool5h: () => pool })).reason, "the pool's 5-hour headroom recovered");
  assert.equal(b.calls.claim.length, 0);
});

test('the reservation covers the claim time: it records the attempt deadline, never its start', async () => {
  const { am, redeemer } = rig();
  const start = Date.now();
  redeemer.now = () => start;
  await redeemer.redeemByRule(am.accounts[0], 'expiry');
  assert.ok(am.accounts[0].quota.claudeResetRuleAt > start, 'later than the attempt start');
  // the same seat exactly 24 h after the attempt START is still refused
  redeemer.now = () => start + RULE_SPACING_MS;
  assert.match((await redeemer.redeemByRule(am.accounts[0], 'expiry')).reason, /in the last 24 h/);
});

// ---------- xreview round 3 (reset rules)
test('final checks: an attempt past its deadline, or a seat disabled/exempted meanwhile, spends nothing; every release is written', async () => {
  const late = rig();
  let t = Date.now();
  late.redeemer.now = () => t;
  late.am.ensureTokenFresh = async () => { t += 60_000; }; // the refresh alone outlasts the 45 s budget
  assert.equal((await late.redeemer.redeemByRule(late.am.accounts[0], 'expiry')).reason, 'ran out of time before the claim');
  assert.equal(late.calls.claim.length, 0);
  assert.equal(late.am.accounts[0].quota.claudeResetRuleAt, undefined);
  assert.equal(late.calls.persisted, 2, 'the reservation, then its release, both written');
  let ex;
  ex = rig({ persist: async () => { ex.am.accounts[0].autoRedeemReset = false; } });
  assert.equal((await ex.redeemer.redeemByRule(ex.am.accounts[0], 'expiry')).reason, 'the seat was disabled or exempted');
  let dis;
  dis = rig({ persist: async () => { dis.am.accounts[0].disabled = true; } });
  assert.equal((await dis.redeemer.redeemByRule(dis.am.accounts[0], 'expiry')).reason, 'the seat was disabled or exempted');
  assert.equal(ex.calls.claim.length + dis.calls.claim.length, 0);
  const no = rig({ claim: () => ({ result: 'not_limited', reason: null }) });
  await no.redeemer.redeemByRule(no.am.accounts[0], 'expiry');
  assert.equal(no.calls.persisted, 2, 'a decline writes the released day');
  assert.equal(no.calls.ruleAtOnDisk[0], undefined);
});

// ---------- xreview round 4 (reset rules)
test('the fleet hold is in the pre-claim save: restored after a crash, it stops a sibling; a decline gives it back', async () => {
  const a = rig({ claim: () => { throw new Error('process died mid-claim'); } });
  await a.redeemer.redeemByRule(a.am.accounts[0], 'expiry').catch(() => {});
  const snapshot = a.am.exportQuotaState(); // what was on disk at the claim
  assert.ok(a.calls.persisted >= 1);
  const b = rig();
  b.am.restoreQuotaState(snapshot);
  assert.match((await b.redeemer.redeemByRule(b.am.accounts[1], 'expiry')).reason, /holding off/);
  assert.equal(b.calls.claim.length, 0);
  const no = rig({ claim: () => ({ result: 'not_limited', reason: null }) });
  await no.redeemer.redeemByRule(no.am.accounts[0], 'expiry');
  assert.ok(!(no.am.accounts[0].quota.claudeResetHoldUntil > Date.now()), 'nothing spent: no hold left');
});

// ---------- spent this week (item 5)
test('every landed reset is recorded on the seat (7 days kept, persisted) and counted in the seat row', async () => {
  const { am, redeemer } = rig();
  am.accounts[0].quota.claudeResetSpends = [Date.now() - 8 * DAY, 'x', Date.now() - DAY];
  await redeemer.redeemByRule(am.accounts[0], 'expiry');
  const spends = am.accounts[0].quota.claudeResetSpends;
  assert.equal(spends.length, 2, 'the 8-day-old and malformed entries dropped, this spend added');
  const fresh = new AccountManager([oauth('a@x.org'), oauth('b@x.org')], 0.98);
  fresh.restoreQuotaState(am.exportQuotaState());
  assert.equal(fresh.accounts[0].quota.claudeResetSpends.length, 2);
  const { seatRows } = await import('../src/seat-resets.js');
  const rows = seatRows({ accounts: fresh.accounts, ledger: null, probe: null, now: Date.now() });
  assert.equal(rows[0].resetsSpent7d, 2);
  assert.equal(rows[1].resetsSpent7d, 0);
  const declined = rig({ claim: () => ({ result: 'not_limited', reason: null }) });
  await declined.redeemer.redeemByRule(declined.am.accounts[0], 'expiry');
  assert.equal(declined.am.accounts[0].quota.claudeResetSpends, undefined, 'a decline spends nothing');
});

// ---------- operator --five-hour (Sen 2026-11-16 10:0x)
test('redeemNamed fiveHour: spends a 5h-only next grant at a live 5-hour wall, never a weekly-clearing one, logs the grant', async () => {
  const five = [{ id: 'gr-5h', resets_left: 1, clears: FIVE, usable_now: true, paused: false, ends_at: new Date(Date.now() + 90 * DAY).toISOString() }];
  const ok = rig({ config: {}, status: () => block({ next_grant_id: 'gr-5h', at_limit: true, exhausted: ['five_hour'] }, five), claim: () => ({ result: 'reset', resetsLeft: 0, cleared: FIVE }), usage: { week: 0.17, five: 1 } });
  const dry = await ok.redeemer.redeemNamed('a', { fiveHour: true, dryRun: true });
  assert.equal(dry.wouldRedeem, true);
  assert.equal(ok.calls.claim.length, 0);
  const r = await ok.redeemer.redeemNamed('a', { fiveHour: true });
  assert.equal(r.redeemed, true, 'the auto switch is off: the operator decides');
  assert.deepEqual(ok.calls.claim, [['a@x.org', 'gr-5h']]);
  assert.equal(r.grantId, 'gr-5h');
  assert.equal(r.fiveHourBefore, 1);
  const weekly = rig({ config: {}, status: () => block({ at_limit: true, exhausted: ['five_hour'] }), usage: { week: 0.17, five: 1 } });
  assert.match((await weekly.redeemer.redeemNamed('a', { fiveHour: true })).reason, /clears the weekly; kept/);
  const off = rig({ config: {}, status: () => block({ next_grant_id: 'gr-5h' }, five), usage: { week: 0.17, five: 0.5 } });
  assert.equal((await off.redeemer.redeemNamed('a', { fiveHour: true })).reason, 'not at its 5-hour wall');
  assert.equal(weekly.calls.claim.length + off.calls.claim.length, 0);
});

test('servableRemaining counts 5h room only on seats whose week is not spent and that are enabled', async () => {
  const { buildQuotaSummary } = await import('../src/quota-summary.js');
  const seatQ = (name, five, week, extra = {}) => ({ name, type: 'oauth', seatTier: 'team_bendep_nonprofit_premium', rateLimitTier: 'default_claude_max_5x',
    quota: { unified5h: five, unified5hReset: Date.now() + H, unified7d: week, unified7dReset: Date.now() + 3 * DAY }, ...extra });
  const s = buildQuotaSummary([seatQ('a', 0.1, 0.25), seatQ('b', 0, 1), seatQ('c', 0, 1), seatQ('d', 0, 0.5, { disabled: true })]);
  const f = s.aggregate.fiveHour;
  assert.equal(f.capacityWeight, 20);
  assert.equal(f.remaining, 0.975, 'the plain figure counts the walled seats');
  assert.equal(f.servableRemaining, 0.225, 'only seat a can serve: 0.9 * 5 / 20');
  const unknownWeek = buildQuotaSummary([seatQ('a', 0.1, 0.25), { ...seatQ('e', 0, null), quota: { unified5h: 0, unified5hReset: Date.now() + H } }]);
  assert.equal(unknownWeek.aggregate.fiveHour.servableRemaining, 0.45, 'a seat with no weekly reading is not room: 0.9 * 5 / 10');
});

// ---------- 2026-11-16 13:08–14:30: every seat stopped at the proxy's 97 % 5h threshold, three seats'
// weeks were spent, and the five-hour rule never fired: the wall was "98 % cached + upstream exhausted"
// (never reached by a seat the proxy stops routing to at 97 %), and the pool figure counted the
// spent-week seats' 5h room (~60 % remaining through the whole wall).
test('five-hour: the wall is the seat\'s own 5h switch threshold (capped at 98 %)', () => {
  const base = { now: NOW, kept: kept(g()), idleMs: 0, pool5hRemaining: 0.05 };
  assert.equal(ruleFor(seat({ unified5h: 0.97, unified7d: 0.4 }), { ...base, fiveHourWall: 0.97 })?.rule, 'five-hour', 'at 97 % with a 97 % threshold');
  assert.equal(ruleFor(seat({ unified5h: 0.96, unified7d: 0.4 }), { ...base, fiveHourWall: 0.97 }), null, 'under the threshold');
  assert.equal(ruleFor(seat({ unified5h: 0.97, unified7d: 0.4 }), { ...base, fiveHourWall: 1 }), null, 'a threshold above 98 % is capped at 98 %');
  assert.equal(ruleFor(seat({ unified5h: 0.98, unified7d: 0.4 }), { ...base, fiveHourWall: 1 })?.rule, 'five-hour');
  assert.equal(ruleFor(seat({ unified5h: 0.97, unified7d: 0.4 }), { ...base, fiveHourWall: null }), null, 'no threshold known: 98 %');
  assert.equal(ruleFor(seat({ unified5h: 0.6, unified7d: 0.4 }), { ...base, fiveHourWall: 0.5 }), null, 'a low threshold (a reservation) is floored at 90 %');
  assert.equal(ruleFor(seat({ unified5h: 0.9, unified7d: 0.4 }), { ...base, fiveHourWall: 0.5 })?.rule, 'five-hour');
  assert.equal(ruleFor(seat({ unified5h: 0.95, unified7d: 0.4 }), { ...base, fiveHourWall: Number.NaN }), null, 'NaN: 98 %');
});

test('redeemByRule five-hour: a live 5h use at the proxy\'s threshold is the wall, even before upstream says exhausted', async () => {
  const five = [{ id: 'gr-5h', resets_left: 1, clears: FIVE, usable_now: true, paused: false, ends_at: new Date(Date.now() + 90 * DAY).toISOString() }];
  const at97 = rig({ status: () => block({ next_grant_id: 'gr-5h' }, five), claim: () => ({ result: 'reset', resetsLeft: 0, cleared: FIVE }), usage: { week: 0.4, five: 0.97 } });
  at97.am.thresholdFor = () => 0.97;
  const r = await at97.redeemer.redeemByRule(at97.am.accounts[0], 'five-hour', '', { pool5h: () => 0.05 });
  assert.equal(r.redeemed, true, r.reason);
  assert.deepEqual(at97.calls.claim, [['a@x.org', 'gr-5h']]);
  const at96 = rig({ status: () => block({ next_grant_id: 'gr-5h' }, five), usage: { week: 0.4, five: 0.96 } });
  at96.am.thresholdFor = () => 0.97;
  assert.equal((await at96.redeemer.redeemByRule(at96.am.accounts[0], 'five-hour', '', { pool5h: () => 0.05 })).reason, 'not at its 5-hour wall');
  assert.equal(at96.calls.claim.length, 0);
});

test('the rule trigger reads the SERVABLE pool figure and the seat\'s 5h threshold', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const tryResetRule ='), src.indexOf('accountManager.onSeatRequest('));
  assert.match(body, /aggregate\?\.fiveHour\?\.servableRemaining/);
  assert.doesNotMatch(body, /aggregate\?\.fiveHour\?\.remaining/, 'never the plain remaining (it counts spent-week seats)');
  assert.match(body, /thresholdFor\('unified5h', account\)/);
  assert.match(body, /ruleFor\(account, \{[^}]*fiveHourWall/);
  assert.match(body, /pool5h: servable5h/);
});

test('a dry run at the proxy\'s 5h threshold (upstream not yet exhausted) names the threshold, never an empty limit list', async () => {
  const five = [{ id: 'gr-5h', resets_left: 1, clears: FIVE, usable_now: true, paused: false, ends_at: new Date(Date.now() + 90 * DAY).toISOString() }];
  const t = rig({ status: () => block({ next_grant_id: 'gr-5h' }, five), usage: { week: 0.56, five: 0.97 } });
  t.am.thresholdFor = () => 0.97;
  const r = await t.redeemer.redeemNamed('a@x.org', { dryRun: true, fiveHour: true });
  assert.equal(r.wouldRedeem, true, r.reason);
  assert.equal(r.reason, 'would redeem: at its 5-hour threshold (5h 97%; upstream reports no limit yet), its reset clears five_hour, seven_day_overage_included');
  assert.equal(t.calls.claim.length, 0);
});
