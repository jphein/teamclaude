import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoutingEvents } from '../src/routing-events.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// JP 2026-11-10: "Teamclaude UI should be part of plan too." The plan reads
// routing decisions as JSON instead of tailing the operator-only log.

test('keeps routing decisions, labelled by kind; drops everything else', () => {
  let t = Date.parse('2026-11-10T15:00:00Z');
  const ev = new RoutingEvents(300, () => t++);
  const lines = [
    '[TeamClaude] Switched to account "claude5@x"',
    '[TeamClaude] Rebalanced "a" → "b": out of the expiry band (1%/h vs 2%/h, tolerance 1.2×)',
    '[TeamClaude] Refresh routing: "a" → "b" (5h resets 2026-11-10T16:00:00.000Z, before no window)',
    '[TeamClaude] Account "a" started a 5h window (resets 1:00:00 PM; at 2026-11-10T15:00:00.000Z, reset 2026-11-10T20:00:00.000Z)',
    '[TeamClaude] Account "a" used up its 5h window (resets 1:00:00 PM)',
    '[TeamClaude] Keep-warm stagger: leaving "c" at its 04:51 slot (weekly limit reached)',
    '[TeamClaude] Switch threshold (unified7d) set to 93% via SSO as "jp"',
    '[TeamClaude] Account "a" disabled via UI',
    '[TeamClaude] Reauth started for "a" via UI',
    '[TeamClaude] Reauthed "a" via dashboard',
    '[TeamClaude] Quota rejection (429) on "a" — throttling 60s and switching account',
    '[TeamClaude] TLS listener: handshake from ? failed: ECONNRESET',
    '[TeamClaude] [familiar] WebSocket /api/frame/sync connected',
    'not ours at all',
  ];
  for (const l of lines) ev.note(l);
  assert.deepEqual(ev.list().map(e => e.kind),
    ['switch', 'rebalance', 'refresh-routing', 'window-start', 'window-spent', 'stagger', 'threshold', 'account', 'reauth', 'reauth', 'quota-429']);
  assert.equal(ev.list()[0].text, 'Switched to account "claude5@x"');
  assert.equal(ev.list()[0].ts, '2026-11-10T15:00:00.000Z');
  assert.deepEqual(ev.list({ kind: 'stagger' }).length, 1);
  assert.deepEqual(ev.list({ since: '2026-11-10T15:00:00.004Z' }).map(e => e.kind), ['stagger', 'threshold', 'account', 'reauth', 'reauth', 'quota-429']);
  assert.deepEqual(ev.list({ limit: 2 }).map(e => e.kind), ['reauth', 'quota-429']);
  assert.match(ev.list({ kind: 'reauth' })[1].text, /^Reauthed /);
});

test('the buffer is bounded and the tap never breaks logging', () => {
  const ev = new RoutingEvents(3);
  const orig = console.log;
  console.log = () => {}; // keep the test output quiet
  const quiet = console.log;
  const undo = ev.tapConsole();
  try {
    for (let i = 0; i < 5; i++) console.log(`[TeamClaude] Switched to account "s${i}"`);
    console.log({ toString() { throw new Error('boom'); } });
  } finally { undo(); }
  assert.equal(console.log, quiet, 'undo restores the previous logger');
  console.log = orig;
  assert.deepEqual(ev.list().map(e => e.text), ['Switched to account "s2"', 'Switched to account "s3"', 'Switched to account "s4"']);
  assert.equal(ev.events.length, 3, 'the buffer itself is bounded, not just the answer');
});

test('GET /teamclaude/events answers like /teamclaude/status does, with filters', async () => {
  const ev = new RoutingEvents();
  ev.note('[TeamClaude] Switched to account "a"');
  ev.note('[TeamClaude] Keep-warm stagger: touching "a" for its 02:00 slot at 2026-11-10T10:00:00.000Z');
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  const server = createProxyServer(am, { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'lane', key: 'tc-lane' }] }, upstream: 'https://api.anthropic.com', accounts: [] }, { routingEvents: ev });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = /** @type {any} */ (server.address()).port;
  try {
    const get = (/** @type {string} */ q, /** @type {Record<string,string>} */ h = {}) => fetch(`http://127.0.0.1:${port}/teamclaude/events${q}`, { headers: h });
    const ok = await get('', { 'x-api-key': 'tc-lane' });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.events.map((/** @type {any} */ e) => e.kind), ['switch', 'stagger']);
    const st = await (await get('?kind=stagger&limit=5', { 'x-api-key': 'tc-test' })).json();
    assert.deepEqual(st.events.map((/** @type {any} */ e) => e.kind), ['stagger']);
    const bad = { 'x-api-key': 'wrong' };
    const status = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: bad });
    const refused = await get('', bad);
    // Loopback is key-exempt in this harness, so the claim is only "same as
    // status": the route sits behind the same gate.
    assert.equal(refused.status, status.status, 'events is gated exactly like status');
  } finally { server.close(); }
});

test('a reauth started with a client key names that client in the log', async () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  const reauth = { start: async () => ({ authUrl: 'https://example.invalid/auth' }), status: () => ({ state: 'idle' }) };
  const server = createProxyServer(am, { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'lane', key: 'tc-lane' }] }, upstream: 'https://api.anthropic.com', accounts: [] }, { reauth });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = /** @type {any} */ (server.address()).port;
  const lines = /** @type {string[]} */ ([]);
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reauth`, {
      method: 'POST', headers: { 'x-api-key': 'tc-lane', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a' }),
    });
    assert.equal(res.status, 200);
  } finally { console.log = orig; server.close(); }
  assert.ok(lines.some(l => l === '[TeamClaude] Reauth started for "a" via client key "lane"'), lines.join('\n'));
});

test('near-limit lines from both quota paths are kept, labelled near-limit', () => {
  const ev = new RoutingEvents();
  ev.note('[TeamClaude] Account "a" 5h at 100.0% usage — will switch on next request');
  ev.note('[TeamClaude] Account "b" 7-day (unified7d_fable) at 96.0% usage — will switch on next request');
  ev.note('[TeamClaude] "c" near quota: 7-day at 95%');
  assert.deepEqual(ev.list().map(e => e.kind), ['near-limit', 'near-limit', 'near-limit']);
});
