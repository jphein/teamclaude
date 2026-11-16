import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { createDefaultConfig } from '../src/config.js';
import { parseResetStatus, claimableGrant, claimClaudeReset, blockedUntil, ClaudeResetRedeemer } from '../src/claude-resets.js';

// Banked Claude usage-limit resets. Nothing here reaches the network: the claim
// spends a real reset on a real account, so every test injects its own fetch.

const H = 3600_000, DAY = 24 * H;
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, orgUuid: 'org-' + name, ...extra });
const ARMED = { autoRedeemResets: true };

/** The cedar_ember block of an account at its Fable limit holding one reset. */
function block(extra = {}, grant = {}) {
  return {
    eligible: true, ineligible_reason: null, at_limit: true, exhausted: ['seven_day_overage_included'],
    next_grant_id: 'opus55-launch-promax-20260921', cooldown_until: null,
    grants: [{ id: 'opus55-launch-promax-20260921', label: 'x', resets_total: 1, resets_left: 1,
      clears: ['five_hour', 'seven_day', 'seven_day_overage_included'], usable_now: true, paused: false,
      use_requires_limit: false, ends_at: new Date(Date.now() + 12 * DAY).toISOString(), ...grant }],
    ...extra,
  };
}

function fableSpent(account, resetIn) {
  Object.assign(account.quota, { unified5h: 0.1, unified7d: 0.5, unified7dFable: 1, unified7dFableReset: Date.now() + resetIn });
  return account;
}

function harness({ accounts = [oauth('a')], status = () => block(), claim = () => ({ result: 'reset', reason: null, resetsLeft: 0, cleared: ['five_hour', 'seven_day', 'seven_day_overage_included'], cooldownUntil: null }), config = { ...ARMED } } = {}) {
  const am = new AccountManager(accounts, 0.98);
  am.accounts.forEach((a, i) => fableSpent(a, (i + 1) * DAY));
  const calls = { status: 0, claim: [], keys: [] };
  const redeemer = new ClaudeResetRedeemer(am, {
    config, log: () => {},
    statusFn: async (account) => { calls.status++; const b = status(account, calls); return { reset: parseResetStatus(b), usage: { fiveHour: { utilization: 0 }, sevenDay: { utilization: 0 }, sevenDayFable: { utilization: 0 } } }; },
    claimFn: async (account, c) => { calls.claim.push(account.name); calls.keys.push(c.requestId); return claim(calls.claim.length, c); },
  });
  am.ensureTokenFresh = async () => {};
  return { am, redeemer, calls };
}

// ── parsing ─────────────────────────────────────────────────────────────────

test('the block parses, and only next_grant_id is claimable', () => {
  const s = parseResetStatus(block());
  assert.equal(s.eligible, true); assert.equal(s.atLimit, true);
  assert.deepEqual(s.exhausted, ['seven_day_overage_included']);
  assert.equal(claimableGrant(s).id, 'opus55-launch-promax-20260921');
  assert.equal(claimableGrant(parseResetStatus(block({ next_grant_id: null }))), null);
  assert.equal(claimableGrant(parseResetStatus(block({ next_grant_id: 'someone-else' }))), null, 'a next id naming no listed grant is not trusted');
  for (const g of [{ resets_left: 0 }, { usable_now: false }, { paused: true }, { ends_at: new Date(Date.now() - 1000).toISOString() }]) {
    assert.equal(claimableGrant(parseResetStatus(block({}, g))), null, JSON.stringify(g));
  }
  assert.equal(parseResetStatus(null), null);
  assert.equal(parseResetStatus({ eligible: 'yes' }), null);
});

test('the claim posts the org-scoped body Claude Code sends, and reads the verdict from the body', async () => {
  let seen;
  const r = await claimClaudeReset({ credential: 'tok', orgUuid: 'org-1' }, { grantId: 'g_1', requestId: 'req-1' }, {
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ result: 'reset', resets_left: 0, cleared: ['five_hour'], cooldown_until: '2026-10-10T09:08:22+00:00' }) }; },
  });
  assert.equal(seen.url, 'https://api.anthropic.com/api/organizations/org-1/reset_rate_limits');
  assert.equal(seen.opts.method, 'POST');
  assert.deepEqual(JSON.parse(seen.opts.body), { program: 'cedar_ember', grant_id: 'g_1', request_id: 'req-1' });
  assert.equal(seen.opts.headers.Authorization, 'Bearer tok');
  assert.equal(r.result, 'reset'); assert.deepEqual(r.cleared, ['five_hour']);
  const bad = await claimClaudeReset({ credential: 'tok', orgUuid: 'org-1' }, { grantId: 'g_1', requestId: 'r' }, { fetchImpl: async () => ({ ok: false, status: 502 }) });
  assert.deepEqual(bad, { error: 'HTTP 502', status: 502 });
  assert.match((await claimClaudeReset({ credential: 'tok' }, { grantId: 'g', requestId: 'r' })).error, /identity/);
  assert.match((await claimClaudeReset({ credential: 'tok', orgUuid: 'o' }, { grantId: 'BAD ID', requestId: 'r' })).error, /malformed/);
});

// ── the pool-dry policy ─────────────────────────────────────────────────────

test('off by default: a config that never mentions the switch spends nothing', async () => {
  assert.equal(createDefaultConfig().autoRedeemResets, false);
  const { am, redeemer, calls } = harness({ config: createDefaultConfig() });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, false); assert.match(r.reason, /switched off/);
  assert.equal(calls.status + calls.claim.length, 0);
});

test('the switch is read live off the shared config: switching it off stops the next refusal', async () => {
  const config = { autoRedeemResets: true };
  const { am, redeemer, calls } = harness({ config, accounts: [oauth('a'), oauth('b')] });
  config.autoRedeemResets = false;
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false);
  assert.equal(calls.claim.length, 0);
});

test('armed: one reset is spent on the account that would otherwise wait longest, and the account is re-read', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('soon'), oauth('late'), oauth('mid')] });
  // fableSpent gives index 0 a 1-day wait, index 1 two days, index 2 three days.
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, true);
  assert.deepEqual(calls.claim, ['mid']);
  assert.equal(am.accounts[2].quota.unified7dFable, 0, 'the quota was re-applied from the fresh read');
  assert.ok(blockedUntil(am.accounts[0]) > 0);
});

test('one dry pool costs one reset: a second refusal right after holds off', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('a'), oauth('b')] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  const again = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(again.redeemed, false); assert.match(again.reason, /holding off/);
  assert.equal(calls.claim.length, 1);
});

test('concurrent refusals share one attempt', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('a'), oauth('b')] });
  const [x, y] = await Promise.all([redeemer.maybeRedeemForPool(am.accounts), redeemer.maybeRedeemForPool(am.accounts)]);
  assert.equal(x.redeemed && y.redeemed, true);
  assert.equal(calls.claim.length, 1);
});

test('nothing is spent where the reset would not return the account to service', async () => {
  const { am, redeemer, calls } = harness({ status: () => block({ exhausted: ['seven_day_overage_included', 'seven_day_sonnet'] }) });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, false); assert.match(r.reason, /does not clear seven_day_sonnet/);
  assert.equal(calls.claim.length, 0);
});

test('an account not actually at a limit, or holding nothing, or ineligible, is passed over', async () => {
  for (const b of [block({ at_limit: false, exhausted: [] }), block({}, { resets_left: 0 }), block({ eligible: false, ineligible_reason: 'tier' })]) {
    const { am, redeemer, calls } = harness({ status: () => b });
    assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false, JSON.stringify(b).slice(0, 80));
    assert.equal(calls.claim.length, 0);
  }
});

test('an account exempted, disabled, without an org id, or reading zero held resets is never asked', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('ex', { autoRedeemReset: false }), oauth('off', { disabled: true }), oauth('noorg', { orgUuid: null }), oauth('zero')] });
  am.accounts[3].quota.resetCredits = { available: 0, applicable: 0, seenAt: Date.now() };
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false);
  assert.equal(calls.status + calls.claim.length, 0);
});

test('upstream declining spends nothing and moves on to the next account', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('a'), oauth('b')], claim: n => (n === 1 ? { result: 'not_limited', reason: null, resetsLeft: 1, cleared: [] } : { result: 'reset', resetsLeft: 0, cleared: ['seven_day_overage_included'] }) });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, true);
  assert.equal(calls.claim.length, 2);
});

test('no verdict: the fleet holds, and the next attempt replays the SAME request id', async () => {
  let fail = true;
  let clock = Date.now();
  const { am, redeemer, calls } = harness({ claim: () => (fail ? { error: 'socket hang up' } : { result: 'already_used', resetsLeft: 0, cleared: ['seven_day_overage_included'] }) });
  redeemer.now = () => clock;
  const first = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(first.redeemed, false); assert.match(first.reason, /may still have gone through/);
  assert.match((await redeemer.maybeRedeemForPool(am.accounts)).reason, /holding off/);
  fail = false;
  clock += 31 * 60 * 1000;
  const later = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(later.redeemed, true, 'already_used for our own key means it went through');
  assert.equal(calls.keys.length, 2);
  assert.equal(calls.keys[0], calls.keys[1]);
});

test('no verdict on one account: no sibling is spent in the same refusal', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('a'), oauth('b')], claim: () => ({ error: 'socket hang up' }) });
  await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(calls.claim.length, 1);
});

test('a 5-hour wall alone is never worth a grant', async () => {
  const { am, redeemer, calls } = harness({ status: () => block({ exhausted: ['five_hour'] }) });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, false); assert.match(r.reason, /no weekly limit/);
  assert.equal(calls.claim.length, 0);
});

test('a cooldown upstream already reports is honoured without a claim', async () => {
  const until = Date.now() + H;
  const { am, redeemer, calls } = harness({ status: () => block({ cooldown_until: new Date(until).toISOString() }) });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, false); assert.match(r.reason, /cooldown/);
  assert.equal(calls.claim.length, 0);
});

test('a reset that landed also lifts a stored upstream rejection', async () => {
  const { am, redeemer } = harness();
  Object.assign(am.accounts[0].quota, { unifiedStatus: 'rejected', unifiedStatusSeenAt: Date.now() });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.equal(am.accounts[0].quota.unifiedStatus, null);
});

test('the fleet hold is saved with the quota state, so a restart does not lift it', async () => {
  const { am, redeemer } = harness({ accounts: [oauth('a'), oauth('b')], claim: () => ({ error: 'socket hang up' }) });
  await redeemer.maybeRedeemForPool(am.accounts);
  const saved = am.exportQuotaState();
  // A fresh process: new manager, new redeemer, nothing held in memory.
  const { am: am2, redeemer: r2, calls } = harness({ accounts: [oauth('a'), oauth('b')] });
  am2.restoreQuotaState(saved);
  const r = await r2.maybeRedeemForPool(am2.accounts);
  assert.equal(r.redeemed, false); assert.match(r.reason, /holding off/);
  assert.equal(calls.claim.length, 0);
});

test('a Codex row or a third-party backend is never a Claude candidate', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('cx', { provider: 'codex', accountId: 'x' }), oauth('nano', { upstream: 'https://api.nano-gpt.com/api' })] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false);
  assert.equal(calls.status + calls.claim.length, 0);
});

// ── through the proxy ───────────────────────────────────────────────────────

async function oneRefusedClaudeRequest({ onRedeem }) {
  let hits = 0;
  const upstream = http.createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const port = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  for (const a of am.accounts) fableSpent(a, 3 * DAY);
  am._nextProbeAt = Date.now() + H;
  const asked = [];
  const hooks = onRedeem ? { redeemClaudeResetForPool: async (cands) => {
    asked.push(cands.map(a => a.name));
    const redeemed = await onRedeem();
    if (redeemed) Object.assign(cands[0].quota, { unified7dFable: 0, unified7d: 0 });
    return { redeemed, reason: 'test' };
  } } : {};
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${port}` }, hooks);
  const pport = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  try {
    const res = await fetch(`http://127.0.0.1:${pport}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-fable-5-1', max_tokens: 1, messages: [] }) });
    await res.text();
    return { status: res.status, hits, asked };
  } finally { proxy.close(); upstream.close(); }
}

test('a dry Claude pool asks the Claude redeemer, and serves the request when one was redeemed', async () => {
  const r = await oneRefusedClaudeRequest({ onRedeem: async () => true });
  assert.deepEqual(r.asked, [['a', 'b']]);
  assert.equal(r.status, 200);
  assert.equal(r.hits, 1);
});

test('a declined redemption leaves the refusal exactly as it was', async () => {
  const r = await oneRefusedClaudeRequest({ onRedeem: async () => false });
  assert.equal(r.asked.length, 1);
  assert.notEqual(r.status, 200);
  assert.equal(r.hits, 0);
});

test('without the hook nothing changes', async () => {
  const r = await oneRefusedClaudeRequest({});
  assert.notEqual(r.status, 200);
  assert.equal(r.hits, 0);
});

// ── the operator's single-seat spend (`teamclaude resets redeem <seat>`) ─────

test('redeemNamed spends exactly the named seat, with the auto switch OFF, and reports weekly before/after', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('a@x.org'), oauth('b@x.org'), oauth('c@x.org')], config: {} });
  // The fresh reads, not the cached quota (0.5): 100% just before the claim, 0% on the re-read after it.
  const reads = [1, 0];
  const inner = redeemer.statusFn;
  redeemer.statusFn = async (/** @type {any} */ a, /** @type {any} */ o) => { const r = await inner(a, o); return { ...r, usage: { ...r.usage, sevenDay: { utilization: reads.shift() } } }; };
  const r = await redeemer.redeemNamed('b');
  assert.equal(r.redeemed, true);
  assert.deepEqual(calls.claim, ['b@x.org'], 'only the named seat; never the one that would wait longest (c)');
  assert.equal(r.reason, 'the operator asked for this seat');
  assert.equal(r.weeklyBefore, 1, 'measured by the status read just ahead of the claim');
  assert.equal(r.weeklyAfter, 0, 'measured by the re-read after the spend');
  assert.equal(am.accounts[1].quota.unified7dFable, 0);
});

test('redeemNamed: a failed re-read after the spend reports the after value as unknown, never the cached one', async () => {
  const { redeemer } = harness({ accounts: [oauth('a@x.org')], config: {} });
  let n = 0;
  const inner = redeemer.statusFn;
  redeemer.statusFn = async (/** @type {any} */ a, /** @type {any} */ o) => (++n === 1 ? inner(a, o) : { error: 'HTTP 503' });
  const r = await redeemer.redeemNamed('a');
  assert.equal(r.redeemed, true);
  assert.equal(r.weeklyAfter, null);
});

test('an unread claim whose grant is no longer listed fails closed: no second spend on a fresh grant', async () => {
  let fail = true;
  let clock = Date.now();
  let listA = true;
  const one = block().grants[0];
  const grants = [];
  const { redeemer } = harness({ accounts: [oauth('a@x.org')], config: {},
    status: () => (listA ? block({ next_grant_id: 'grant-a' }, { id: 'grant-a' }) : { ...block({ next_grant_id: 'grant-b' }), grants: [{ ...one, id: 'grant-b' }] }),
    claim: (_n, c) => { grants.push(c.grantId); return fail ? { error: 'socket hang up' } : { result: 'reset', resetsLeft: 0, cleared: ['seven_day'] }; } });
  redeemer.now = () => clock;
  assert.equal((await redeemer.redeemNamed('a')).maybeSpent, true);
  fail = false; listA = false;
  clock += 31 * 60 * 1000;
  for (const dryRun of [true, false]) {
    const r = await redeemer.redeemNamed('a', { dryRun });
    assert.equal(r.redeemed, false);
    assert.equal(r.maybeSpent, true);
    assert.match(r.reason, /no longer listed/);
  }
  assert.deepEqual(grants, ['grant-a'], 'grant-b was never claimed');
});

test('redeemNamed: an unknown, ambiguous, empty or non-string seat spends nothing', async () => {
  const { redeemer, calls } = harness({ accounts: [oauth('a@x.org'), oauth('a@y.org'), oauth('b@x.org')], config: {} });
  for (const seat of ['a', 'zz', '', undefined, 7, 'x'.repeat(200)]) {
    const r = await redeemer.redeemNamed(seat);
    assert.equal(r.redeemed, false, String(seat));
  }
  assert.equal((await redeemer.redeemNamed('a')).reason, 'no single seat by that name');
  assert.equal(calls.claim.length, 0);
  assert.equal(calls.status, 0, 'not even a status read');
  assert.equal((await redeemer.redeemNamed('a@y.org')).redeemed, true, 'the full name picks one of the two');
  assert.deepEqual(calls.claim, ['a@y.org']);
});

test('redeemNamed dry run: every check, a status read, no claim, and no cooldown left behind', async () => {
  let atLimit = false;
  const { am, redeemer, calls } = harness({ accounts: [oauth('a@x.org')], config: {}, status: () => block({ at_limit: atLimit }) });
  const no = await redeemer.redeemNamed('a', { dryRun: true });
  assert.equal(no.redeemed, false);
  assert.equal(no.wouldRedeem, undefined);
  assert.equal(no.reason, 'not at a usage limit');
  assert.equal(redeemer._stateFor(am.accounts[0]).cooldownUntil, 0, 'a dry run never cools the seat down');
  atLimit = true;
  const yes = await redeemer.redeemNamed('a', { dryRun: true });
  assert.equal(yes.wouldRedeem, true);
  assert.equal(yes.redeemed, false);
  assert.match(yes.reason, /^would redeem: at seven_day_overage_included, its reset clears five_hour, seven_day, seven_day_overage_included$/);
  assert.equal(calls.claim.length, 0);
  assert.equal(calls.status, 2);
  assert.equal(redeemer.fleetHoldUntil, 0, 'no fleet hold from a dry run');
  assert.equal((await redeemer.redeemNamed('a')).redeemed, true, 'and the real spend right after is not held off');
});

test('redeemNamed honours the fleet hold, the in-flight lock, and every pool-path refusal', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('a@x.org'), oauth('b@x.org')], config: {} });
  assert.equal((await redeemer.redeemNamed('a')).redeemed, true);
  const held = await redeemer.redeemNamed('b');
  assert.equal(held.redeemed, false);
  assert.equal(held.reason, 'holding off after a recent Claude reset attempt');
  assert.deepEqual(calls.claim, ['a@x.org']);

  const two = harness({ accounts: [oauth('a@x.org'), oauth('b@x.org')], config: {} });
  const [first, second] = await Promise.all([two.redeemer.redeemNamed('a'), two.redeemer.redeemNamed('b')]);
  assert.equal(first.redeemed, true);
  assert.equal(second.reason, 'another reset attempt is in flight');
  assert.deepEqual(two.calls.claim, ['a@x.org']);

  const weekly = harness({ accounts: [oauth('a@x.org')], config: {}, status: () => block({ exhausted: ['seven_day'] }, { clears: ['five_hour', 'seven_day_overage_included'] }) });
  assert.equal((await weekly.redeemer.redeemNamed('a')).reason, 'its reset does not clear seven_day');
  const fiveHour = harness({ accounts: [oauth('a@x.org')], config: {}, status: () => block({ exhausted: ['five_hour'] }) });
  assert.equal((await fiveHour.redeemer.redeemNamed('a')).reason, 'no weekly limit is exhausted');
  assert.equal(weekly.calls.claim.length + fiveHour.calls.claim.length, 0);

  const off = harness({ accounts: [oauth('a@x.org', { disabled: true }), oauth('b@x.org', { orgUuid: undefined }), { name: 'k@x.org', type: 'apikey', apiKey: 'sk-test' }], config: {} });
  assert.equal((await off.redeemer.redeemNamed('a')).reason, 'the seat is disabled');
  assert.equal((await off.redeemer.redeemNamed('b')).reason, 'not a Claude subscription seat');
  assert.equal((await off.redeemer.redeemNamed('k')).reason, 'not a Claude subscription seat');
  assert.equal(off.calls.claim.length, 0);
  void am;
});

test('POST /teamclaude/resets/redeem: shared key only, one named seat, dryRun passed through; client keys refused', async () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'token' }], 0.98);
  const seen = [];
  // trustLoopback off, as on the VM: the test's loopback caller is then just a caller with a key.
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test', trustLoopback: false, clientKeys: [{ name: 'lane', key: 'lane-key' }] }, upstream: 'http://127.0.0.1:9' }, {
    redeemSeatReset: async (/** @type {any} */ o) => { seen.push({ seat: o.seat, dryRun: o.dryRun }); return { redeemed: false, wouldRedeem: true, account: o.seat, reason: 'would redeem' }; },
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = proxy.address().port;
  const post = (body, key = 'tc-test', raw) => fetch(`http://127.0.0.1:${port}/teamclaude/resets/redeem`, {
    method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body),
  });
  try {
    const ok = await post({ seat: 'claude2', dryRun: true });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).wouldRedeem, true);
    assert.equal((await post({ seat: 'claude2' })).status, 200);
    assert.deepEqual(seen, [{ seat: 'claude2', dryRun: true }, { seat: 'claude2', dryRun: false }]);
    assert.equal((await post({ seat: 'claude2' }, 'lane-key')).status, 403, 'a client key never spends');
    assert.equal((await post({ seat: 'claude2' }, 'wrong')).status, 401);
    for (const bad of [{}, { seat: '' }, { seat: 7 }, { seat: ['a'] }, { seat: 'a', dryRun: 'yes' }, { seat: 'x'.repeat(129) }]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await post(null, 'tc-test', '{not json')).status, 400);
    const page = await fetch(`http://127.0.0.1:${port}/teamclaude/resets/redeem`, { method: 'POST', headers: { 'x-api-key': 'tc-test', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: '{"seat":"claude2"}' });
    assert.equal(page.status, 403, 'never from a web page');
    assert.equal(seen.length, 2, 'only the two shared-key calls reached the hook');
  } finally { proxy.close(); }
});

// ── xreview round 1 (redeem verb) ───────────────────────────────────────────

test('a 2xx with no known verdict is no verdict: maybeSpent, the fleet holds, the key is kept for a replay', async () => {
  let answer = { result: null };
  let clock = Date.now();
  const { am, redeemer, calls } = harness({ accounts: [oauth('a@x.org'), oauth('b@x.org')], config: {}, claim: () => answer });
  redeemer.now = () => clock;
  for (const odd of [{ result: null }, { result: 'spent_maybe' }, {}]) {
    answer = odd;
    clock += 31 * 60 * 1000;
    const r = await redeemer.redeemNamed('a');
    assert.equal(r.redeemed, false);
    assert.equal(r.maybeSpent, true, JSON.stringify(odd));
    assert.match(r.reason, /may still have gone through/);
    assert.ok(redeemer.fleetHoldUntil > clock, 'the fleet holds off');
    assert.match((await redeemer.redeemNamed('b')).reason, /holding off/, 'no sibling is spent meanwhile');
  }
  assert.equal(new Set(calls.keys).size, 1, 'every retry replayed the same request id');
  void am;
});

test('an unread claim is replayed on ITS grant even when upstream now names another next grant', async () => {
  let fail = true;
  let clock = Date.now();
  const grants = [];
  const one = block().grants[0];
  const both = (/** @type {string} */ next) => ({ ...block({ next_grant_id: next }), grants: [{ ...one, id: 'grant-a' }, { ...one, id: 'grant-b' }] });
  let next = 'grant-a';
  const { redeemer, calls } = harness({ accounts: [oauth('a@x.org')], config: {}, status: () => both(next),
    claim: (_n, c) => { grants.push(c.grantId); return fail ? { error: 'socket hang up' } : { result: 'already_used', resetsLeft: 0, cleared: ['seven_day'] }; } });
  redeemer.now = () => clock;
  assert.equal((await redeemer.redeemNamed('a')).maybeSpent, true);
  fail = false;
  next = 'grant-b';
  clock += 31 * 60 * 1000;
  const later = await redeemer.redeemNamed('a');
  assert.equal(later.redeemed, true);
  assert.deepEqual(grants, ['grant-a', 'grant-a'], 'the pending grant, not the new next one');
  assert.equal(calls.keys[0], calls.keys[1]);
});

test('POST /teamclaude/resets/redeem: a present dryRun that is not a boolean (null included) is refused, never a spend', async () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'token' }], 0.98);
  let calls = 0;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test', trustLoopback: false }, upstream: 'http://127.0.0.1:9' }, {
    redeemSeatReset: async () => { calls++; return { redeemed: true, account: 'a', reason: 'x' }; },
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = proxy.address().port;
  try {
    for (const raw of ['{"seat":"a","dryRun":null}', '{"seat":"a","dryRun":0}', '{"seat":"a","dryRun":"false"}', '["a"]', 'null', '"a"']) {
      const r = await fetch(`http://127.0.0.1:${port}/teamclaude/resets/redeem`, { method: 'POST', headers: { 'x-api-key': 'tc-test', 'content-type': 'application/json' }, body: raw });
      assert.equal(r.status, 400, raw);
    }
    assert.equal(calls, 0);
  } finally { proxy.close(); }
});

test('a vanished pending grant fails closed WITHOUT a status read per request after the hold', async () => {
  let fail = true, listA = true, clock = Date.now();
  const one = block().grants[0];
  const { am, redeemer, calls } = harness({ status: () => (listA ? block({ next_grant_id: 'grant-a' }, { id: 'grant-a' }) : { ...block({ next_grant_id: 'grant-b' }), grants: [{ ...one, id: 'grant-b' }] }),
    claim: () => (fail ? { error: 'socket hang up' } : { result: 'reset', resetsLeft: 0, cleared: ['seven_day'] }) });
  redeemer.now = () => clock;
  await redeemer.maybeRedeemForPool(am.accounts);
  fail = false; listA = false;
  clock += 31 * 60 * 1000;
  const reads = calls.status;
  await redeemer.maybeRedeemForPool(am.accounts);
  await redeemer.maybeRedeemForPool(am.accounts);
  await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(calls.status - reads, 1, 'one read, then the seat cools down');
  assert.equal(calls.claim.length, 1);
});

test('POST /teamclaude/resets/redeem passes fiveHour through and refuses a non-boolean one', async () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'token' }], 0.98);
  const seen = [];
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test', trustLoopback: false }, upstream: 'http://127.0.0.1:9' }, {
    redeemSeatReset: async (o) => { seen.push({ seat: o.seat, fiveHour: o.fiveHour }); return { redeemed: false, account: o.seat, reason: 'x' }; },
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = proxy.address().port;
  const post = (raw) => fetch(`http://127.0.0.1:${port}/teamclaude/resets/redeem`, { method: 'POST', headers: { 'x-api-key': 'tc-test', 'content-type': 'application/json' }, body: raw });
  try {
    assert.equal((await post('{"seat":"claude","fiveHour":true,"dryRun":true}')).status, 200);
    assert.equal((await post('{"seat":"claude","fiveHour":"yes"}')).status, 400);
    assert.equal((await post('{"seat":"claude","fiveHour":null}')).status, 400);
    assert.deepEqual(seen, [{ seat: 'claude', fiveHour: true }]);
  } finally { proxy.close(); }
});
