import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepStatus, resetSummary, WindowLedger, windowsLeft, redeemVerdict, ResetsProbe, seatRows, PROBE_MIN_INTERVAL_MS } from '../src/seat-resets.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const NOW = Date.parse('2026-11-16T07:00:00Z');
const H = 3600_000;
const GRANT = 'cg_01ABCDEFGHJKMNPQRSTVWXYZ01';
const status = (over = {}) => ({
  eligible: true, ineligibleReason: null, atLimit: false, exhausted: [], nextGrantId: GRANT, cooldownUntil: null,
  grants: [{ id: GRANT, resetsLeft: 1, clears: ['five_hour', 'seven_day'], usableNow: true, paused: false, endsAt: NOW + 10 * 24 * H }],
  ...over,
});

// ---------- the reset summary never carries a grant id
test('resetSummary counts live resets, the soonest expiry and what they clear, and drops every grant id', () => {
  const s = resetSummary(status({ grants: [
    { id: GRANT, resetsLeft: 1, clears: ['seven_day'], usableNow: true, paused: false, endsAt: NOW + 5 * 24 * H },
    { id: 'cg_02', resetsLeft: 2, clears: ['five_hour'], usableNow: false, paused: false, endsAt: NOW + 9 * 24 * H },
    { id: 'cg_03', resetsLeft: 1, clears: ['seven_day'], usableNow: true, paused: false, endsAt: NOW - H },
    { id: 'cg_04', resetsLeft: 0, clears: ['seven_day'], usableNow: true, paused: false, endsAt: null },
  ] }), NOW);
  assert.deepEqual(s, { eligible: true, ineligibleReason: null, available: 3, applicable: 1, expiresAt: NOW + 5 * 24 * H, weeklyApplicable: 1, weeklyExpiresAt: NOW + 5 * 24 * H, atLimit: false, cooldownUntil: null, clears: ['five_hour', 'seven_day'] });
  assert.doesNotMatch(JSON.stringify(s), /cg_/, 'no grant id in the summary');
});

test('resetSummary: an ineligible block is reported with its reason, not as zero resets held', () => {
  const s = resetSummary(status({ eligible: false, ineligibleReason: 'surface', grants: [] }), NOW);
  assert.equal(s?.eligible, false);
  assert.equal(s?.ineligibleReason, 'surface');
  assert.equal(resetSummary(null, NOW), null);
});

// ---------- the window ledger
test('WindowLedger: a window burns what the weekly gained by the next start; a week reset in between is unknown', () => {
  let now = NOW;
  const l = new WindowLedger({ now: () => now, log: () => {} });
  const wk = NOW + 3 * 24 * H;
  l.record('a', 0.10, wk); now += 5 * H;
  l.record('a', 0.18, wk); now += 5 * H;
  l.record('a', 0.30, wk); now += 5 * H;
  l.record('a', 0.02, wk + 7 * 24 * H); // the week reset: that window's burn is unknown, not negative
  assert.deepEqual(l.seats.a.map(r => r.burn), [0.07999999999999999, 0.12, null, undefined]);
  assert.deepEqual(l.burn('a'), { burn: 0.09999999999999999, windows: 2 });
  assert.deepEqual(l.burn('nobody'), { burn: null, windows: 0 });
});

test('WindowLedger: keeps 7 days, persists (0600) and reloads, ignores a malformed file', () => {
  const d = mkdtempSync(join(tmpdir(), 'tc-windows-'));
  try {
    const path = join(d, 'w.json');
    let now = NOW;
    const l = new WindowLedger({ statePath: path, now: () => now, log: () => {} });
    l.record('a', 0.1, NOW); now += 8 * 24 * H; l.record('a', 0.2, NOW + 7 * 24 * H);
    assert.equal(l.seats.a.length, 1, 'the 8-day-old start is pruned');
    const again = new WindowLedger({ statePath: path, now: () => now, log: () => {} });
    assert.deepEqual(again.seats, l.seats);
    writeFileSync(path, '{"seats": {"a": [{"start": "x"}]}}');
    assert.deepEqual({ ...new WindowLedger({ statePath: path, log: () => {} }).seats }, {});
    writeFileSync(path, 'not json');
    assert.deepEqual({ ...new WindowLedger({ statePath: path, log: () => {} }).seats }, {});
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('windowsLeft: whole windows at the measured burn; "measuring" until one window is measured, never a guess', () => {
  assert.deepEqual(windowsLeft(0.6, { burn: 0.1, windows: 3 }), { windowsLeft: 4, basis: 'median burn 10.0% over 3 windows' });
  assert.deepEqual(windowsLeft(0.6, { burn: null, windows: 0 }), { windowsLeft: null, basis: 'measuring' });
  assert.deepEqual(windowsLeft(null, { burn: 0.1, windows: 1 }), { windowsLeft: null, basis: 'weekly use unknown' });
  assert.equal(windowsLeft(1.2, { burn: 0.1, windows: 1 }).windowsLeft, 0);
  assert.deepEqual(windowsLeft(1, { burn: null, windows: 0 }), { windowsLeft: 0, basis: 'weekly spent' });
});

// ---------- the opt-in redeem rule, as a verdict
const spent = (over = {}) => ({ name: 's', weeklyUsed: 1, weeklyResetAt: NOW + 3 * 24 * H, resets: resetSummary(status(), NOW), ...over });
const dry = { poolWeeklyRemaining: 0.03, othersWithRoom: 0 };
test('redeemVerdict: would redeem only when the pool is nearly dry, the seat is spent and its week is far off', () => {
  assert.deepEqual(redeemVerdict(spent(), dry, { now: NOW }), { would: true, reason: 'pool nearly dry, seat spent, its week far from resetting' });
  for (const [seat, pool, why] of [
    [spent({ resets: null }), dry, /not read/],
    [spent({ resets: resetSummary(status({ eligible: false, ineligibleReason: 'surface', grants: [] }), NOW) }), dry, /not eligible \(surface\)/],
    [spent({ resets: resetSummary(status({ grants: [] }), NOW) }), dry, /holds no reset/],
    [spent({ resets: resetSummary(status({ grants: [{ id: GRANT, resetsLeft: 1, clears: ['seven_day'], usableNow: false, paused: false, endsAt: null }] }), NOW) }), dry, /none usable now/],
    [spent({ resets: resetSummary(status({ grants: [{ id: GRANT, resetsLeft: 1, clears: ['five_hour'], usableNow: true, paused: false, endsAt: null }] }), NOW) }), dry, /no usable reset clears the weekly/],
    [spent({ resets: resetSummary(status({ cooldownUntil: NOW + H }), NOW) }), dry, /cooldown/],
    [spent({ weeklyUsed: 0.9 }), dry, /weekly is not spent/],
    [spent(), { poolWeeklyRemaining: 0.03, othersWithRoom: 2 }, /2 other seats have weekly room/],
    [spent(), { poolWeeklyRemaining: 0.2, othersWithRoom: 0 }, /pool weekly 20% is not under 5%/],
    [spent({ weeklyResetAt: NOW + 10 * H }), dry, /resets by itself in 10\.0 h/],
  ]) {
    const v = redeemVerdict(/** @type {any} */ (seat), /** @type {any} */ (pool), { now: NOW });
    assert.equal(v.would, false, String(why));
    assert.match(v.reason, /** @type {RegExp} */ (why));
  }
});

test('redeemVerdict: a reset that would expire before the week resets is worth spending even close to the reset', () => {
  const r = resetSummary(status({ grants: [{ id: GRANT, resetsLeft: 1, clears: ['seven_day'], usableNow: true, paused: false, endsAt: NOW + 5 * H }] }), NOW);
  const v = redeemVerdict(spent({ weeklyResetAt: NOW + 10 * H, resets: r }), dry, { now: NOW });
  assert.deepEqual(v, { would: true, reason: 'pool nearly dry and the reset would expire before the week resets' });
});

// ---------- the probe
test('ResetsProbe: reads Claude OAuth seats only, keeps summaries without ids, rate-limits, keeps the last reading on error', async () => {
  let now = NOW; const calls = []; const applied = [];
  let fail = false;
  const accounts = [
    { name: 'a', type: 'oauth', credential: 't' },
    { name: 'codex', type: 'oauth', provider: 'codex', credential: 't' },
    { name: 'off', type: 'oauth', disabled: true, credential: 't' },
    { name: 'key', type: 'api', credential: 't' },
  ];
  const p = new ResetsProbe({
    accounts: () => accounts,
    fetchStatus: async (/** @type {any} */ acc) => { calls.push(acc.name); return fail ? { error: 'HTTP 503' } : { reset: status(), usage: { fiveHour: null } }; },
    applyUsage: (acc) => applied.push(acc.name),
    now: () => now,
  });
  await p.probe();
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(applied, ['a'], 'the usage read on the way is applied too');
  assert.equal(resetSummary(p.byName.get('a')?.kept, NOW)?.available, 1);
  assert.doesNotMatch(JSON.stringify([...p.byName]), /cg_/);
  const okAt = p.byName.get('a')?.okAt;
  now += PROBE_MIN_INTERVAL_MS - 1; await p.probe();
  assert.equal(calls.length, 1, 'within 10 minutes: not asked again');
  fail = true; await p.probe({ force: true });
  assert.equal(p.byName.get('a')?.error, 'http 503');
  assert.equal(resetSummary(p.byName.get('a')?.kept, now)?.available, 1, 'an error keeps the last good reading');
  assert.equal(p.byName.get('a')?.okAt, okAt, 'and its time stays the time it was READ, not tried');
  assert.equal(p.byName.get('a')?.triedAt, now);
});

// ---------- the per-seat rows
test('seatRows: window state, next window from the stagger, windows left, resets, and the dry-run verdict', () => {
  const accounts = [
    { name: 'a', type: 'oauth', quota: { unified5h: 0.4, unified5hReset: NOW + 2 * H, unified7d: 0.5, unified7dReset: NOW + 3 * 24 * H } },
    { name: 'b', type: 'oauth', quota: { unified7d: 1, unified7dReset: NOW + 3 * 24 * H } },
    { name: 'x', type: 'oauth', provider: 'codex', quota: {} },
  ];
  const ledger = new WindowLedger({ log: () => {} });
  ledger.seats.a = [{ start: NOW - 10 * H, weeklyAtStart: 0.3, burn: 0.1 }, { start: NOW - 2 * H, weeklyAtStart: 0.4 }];
  const probe = new ResetsProbe({ accounts: () => [], now: () => NOW });
  probe.byName.set('b', { kept: keepStatus(status()), okAt: NOW, triedAt: NOW, error: null });
  const rows = seatRows({ accounts, ledger, probe, staggerSeats: [{ name: 'b', nextTouchAt: new Date(NOW + 4 * H).toISOString() }], poolWeeklyRemaining: 0.03, now: NOW, dryRun: true });
  assert.equal(rows.length, 2, 'Claude seats only');
  const [a, b] = rows;
  assert.equal(a.inWindow, true);
  assert.equal(a.windowEndsAt, new Date(NOW + 2 * H).toISOString());
  assert.equal(a.nextWindowAt, new Date(NOW + 2 * H).toISOString());
  assert.equal(a.nextWindowBasis, 'after this window');
  assert.equal(a.windowsLeft, 5);
  assert.equal(a.resets, null);
  assert.equal(a.resetsError, 'not probed yet');
  assert.equal(b.inWindow, false);
  assert.equal(b.nextWindowAt, new Date(NOW + 4 * H).toISOString());
  assert.equal(b.nextWindowBasis, 'stagger slot');
  assert.equal(b.windowsLeft, 0); // its week is spent: 0 without any measured burn
  assert.equal(b.windowsLeftBasis, 'weekly spent');
  assert.equal(b.resets.available, 1);
  assert.equal(b.resets.weeklyApplicable, 1);
  assert.equal(b.resetsError, null);
  assert.equal(b.resets.expiresAt, new Date(NOW + 10 * 24 * H).toISOString());
  assert.equal(a.redeem.would, false);
  assert.match(a.redeem.reason, /not read/);
  assert.deepEqual(b.redeem, { would: false, reason: '1 other seat has weekly room' }, 'a still has weekly room');
  assert.doesNotMatch(JSON.stringify(rows), /cg_/);
  assert.equal(seatRows({ accounts, ledger, probe, now: NOW })[0].redeem, undefined, 'no verdict without dryRun');
});

// ---------- nothing in the read side can spend
test('seat-resets.js cannot spend: it imports no claim call and never names the reset endpoint', () => {
  const src = readFileSync(new URL('../src/seat-resets.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /claimClaudeReset|reset_rate_limits|method:\s*'POST'/);
});

// ---------- the route
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
test('GET /teamclaude/resets passes probe and dryRun through, and is read-only (no POST route)', async () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'token' }], 0.98);
  const seen = [];
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:9' }, {
    getSeatResets: async (/** @type {any} */ o) => { seen.push(o); return { armed: false, probedAt: null, seats: [] }; },
  });
  const port = await listen(proxy);
  try {
    const get = (path, method = 'GET') => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path, method, headers: { 'x-api-key': 'tc-test' } }, res => {
        let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      r.on('error', reject); r.end();
    });
    const one = /** @type {any} */ (await get('/teamclaude/resets'));
    assert.equal(one.status, 200);
    assert.deepEqual(JSON.parse(one.body), { armed: false, probedAt: null, seats: [] });
    await get('/teamclaude/resets?probe=1&dryRun=1');
    assert.deepEqual(seen, [{ probe: false, dryRun: false }, { probe: true, dryRun: true }]);
    const post = /** @type {any} */ (await get('/teamclaude/resets', 'POST'));
    assert.notEqual(post.status, 200, 'no POST: nothing here spends');
    assert.equal(seen.length, 2);
  } finally { proxy.close(); }
});

// ---------- round-1 review cases
test('a usable reset that clears only the 5-hour window, beside an unusable weekly one, is not a weekly redeem', () => {
  const r = resetSummary(status({ grants: [
    { id: GRANT, resetsLeft: 1, clears: ['five_hour'], usableNow: true, paused: false, endsAt: null },
    { id: 'cg_02', resetsLeft: 1, clears: ['seven_day'], usableNow: false, paused: true, endsAt: null },
  ] }), NOW);
  assert.equal(r?.applicable, 1);
  assert.equal(r?.weeklyApplicable, 0);
  assert.deepEqual(redeemVerdict(spent({ resets: r }), dry, { now: NOW }), { would: false, reason: 'no usable reset clears the weekly' });
});

test('an unknown weekly reset time is a "no", not "far from resetting"', () => {
  assert.deepEqual(redeemVerdict(spent({ weeklyResetAt: null }), dry, { now: NOW }), { would: false, reason: 'its weekly reset time is unknown' });
});

test('a kept grant that expires after the probe stops counting when the view is built later', () => {
  const kept = keepStatus(status({ grants: [{ id: GRANT, resetsLeft: 1, clears: ['seven_day'], usableNow: true, paused: false, endsAt: NOW + 5 * 60_000 }] }));
  assert.equal(resetSummary(kept, NOW)?.weeklyApplicable, 1);
  assert.equal(resetSummary(kept, NOW + 10 * 60_000)?.weeklyApplicable, 0);
  assert.equal(resetSummary(kept, NOW + 10 * 60_000)?.available, 0);
});

test('the ledger never compares across a week reset, even when utilisation rose', () => {
  let now = NOW; const l = new WindowLedger({ now: () => now, log: () => {} });
  l.record('a', 0.10, NOW + 2 * H); now += 5 * H;
  l.record('a', 0.30, NOW + 2 * H + 7 * 24 * H);
  assert.equal(l.seats.a[0].burn, null);
  l.record('b', 0.10, null); l.record('b', 0.20, null);
  assert.equal(l.seats.b[0].burn, null, 'an unknown week is not the same week');
});

test('the ledger drops windows older than 7 days when read, not only on the next start', () => {
  let now = NOW; const l = new WindowLedger({ now: () => now, log: () => {} });
  l.record('a', 0.1, NOW + 24 * H); now += 5 * H; l.record('a', 0.2, NOW + 24 * H);
  assert.equal(l.burn('a').windows, 1);
  now += 8 * 24 * H;
  assert.deepEqual(l.burn('a'), { burn: null, windows: 0 });
});

test('a failure is a fixed category: exception text (which could hold a token or an id) never reaches the view', async () => {
  const p = new ResetsProbe({ accounts: () => [{ name: 'a', type: 'oauth', credential: 't' }], fetchStatus: async () => { throw new Error('boom Authorization: Bearer sk-ant-oat01-SECRET cg_01ABCDEF'); }, now: () => NOW });
  await p.probe();
  assert.equal(p.byName.get('a')?.error, 'read failed');
  const p2 = new ResetsProbe({ accounts: () => [{ name: 'a', type: 'oauth', credential: 't' }], fetchStatus: async () => ({ error: 'HTTP 429: slow down sk-ant-x', status: 429 }), now: () => NOW });
  await p2.probe();
  assert.equal(p2.byName.get('a')?.error, 'http 429');
  const rows = seatRows({ accounts: [{ name: 'a', type: 'oauth', quota: {} }], ledger: null, probe: p, now: NOW });
  assert.doesNotMatch(JSON.stringify(rows), /sk-ant|SECRET|cg_|Bearer/);
});

// ---------- round-2 review cases
test('a peer whose weekly use is unknown makes the verdict a "no"', () => {
  assert.deepEqual(redeemVerdict(spent(), { poolWeeklyRemaining: 0.03, othersWithRoom: 0, othersUnknown: 1 }, { now: NOW }), { would: false, reason: "1 other seat's weekly use unknown" });
  const rows = seatRows({ accounts: [
    { name: 'a', type: 'oauth', quota: { unified7d: 1, unified7dReset: NOW + 3 * 24 * H } },
    { name: 'b', type: 'oauth', quota: {} },
  ], ledger: null, probe: Object.assign(new ResetsProbe({ accounts: () => [], now: () => NOW }), {}), poolWeeklyRemaining: 0.03, now: NOW, dryRun: true });
  assert.equal(rows[0].redeem.would, false);
});

test('seat names like __proto__ or constructor cannot break the ledger', () => {
  const l = new WindowLedger({ now: () => NOW, log: () => {} });
  for (const n of ['__proto__', 'constructor', 'toString']) { l.record(n, 0.1, NOW + H); l.record(n, 0.2, NOW + H); }
  assert.equal(l.burn('constructor').windows, 1);
  assert.equal(l.burn('__proto__').windows, 1);
  assert.equal(Object.getPrototypeOf(l.seats), null);
});

test('a malformed reading is a failed read, and the cooldown still holds afterwards', async () => {
  let calls = 0; let now = NOW;
  const p = new ResetsProbe({ accounts: () => [{ name: 'a', type: 'oauth', credential: 't' }], fetchStatus: async () => { calls++; return { reset: { eligible: true, grants: null } }; }, now: () => now });
  await p.probe();
  assert.equal(p.byName.get('a')?.error, 'read failed');
  now += 1000; await p.probe();
  assert.equal(calls, 1, 'not asked again within the cooldown');
});

test('a timestamp Date cannot represent is shown as unknown, not a crash', () => {
  const rows = seatRows({ accounts: [{ name: 'a', type: 'oauth', quota: { unified7d: 0.5, unified7dReset: 1e20, unified5hReset: 1e20 } }], ledger: null, probe: null, now: NOW });
  assert.equal(rows[0].weeklyResetAt, null);
  assert.equal(rows[0].windowEndsAt, null);
});

test('an unrepresentable weekly reset time is unknown to the verdict too, not "far from resetting"', () => {
  const probe = new ResetsProbe({ accounts: () => [], now: () => NOW });
  probe.byName.set('a', { kept: keepStatus(status()), okAt: NOW, triedAt: NOW, error: null });
  const rows = seatRows({ accounts: [{ name: 'a', type: 'oauth', quota: { unified7d: 1, unified7dReset: 1e20 } }], ledger: null, probe, poolWeeklyRemaining: 0.03, now: NOW, dryRun: true });
  assert.equal(rows[0].weeklyResetAt, null);
  assert.deepEqual(rows[0].redeem, { would: false, reason: 'its weekly reset time is unknown' });
});
