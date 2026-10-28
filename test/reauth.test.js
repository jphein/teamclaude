import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReauthManager } from '../src/reauth.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// ── test doubles ──────────────────────────────────────────────

function fakeSession() {
  let resolveCode, rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  codePromise.catch(() => {}); // pre-armed rejection handler; the manager attaches its own
  const session = {
    authUrl: 'https://claude.ai/oauth/authorize?mock=1',
    state: 'st',
    codePromise,
    closed: false,
    exchanged: null,
    async exchange(code) {
      session.exchanged = code;
      return { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 };
    },
    close() { session.closed = true; },
  };
  return { session, resolveCode, rejectCode };
}

function makeManager({ accounts, profile }) {
  const sessions = [];
  const persisted = [];
  let reloads = 0;
  const mgr = createReauthManager({
    accountManager: { accounts },
    createSession: async () => {
      const s = fakeSession();
      sessions.push(s);
      return s.session;
    },
    fetchProfileFn: async () => profile,
    persistTokens: async (name, creds, prof) => { persisted.push({ name, creds, prof }); },
    reload: async () => { reloads++; },
    log: () => {},
  });
  return { mgr, sessions, persisted, reloads: () => reloads };
}

// Wait for an async state transition (browser-callback completions run
// detached from any awaitable call).
async function until(fn, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('condition not reached in time');
}

const OAUTH_ACCT = () => ({ name: 'jp@x.com', type: 'oauth', accountUuid: 'u1', orgUuid: 'o1' });
const PROFILE_OK = { accountUuid: 'u1', orgUuid: 'o1', orgName: 'Org', email: 'jp@x.com' };

// ── manager: lifecycle ────────────────────────────────────────

test('start() opens a pending session for an oauth account', async () => {
  const { mgr } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  const { authUrl } = await mgr.start('jp@x.com');
  assert.match(authUrl, /^https:\/\/claude\.ai/);
  const st = mgr.status();
  assert.equal(st.state, 'pending');
  assert.equal(st.account, 'jp@x.com');
  assert.equal(st.error, null);
});

test('status() is idle before any start', () => {
  const { mgr } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  assert.equal(mgr.status().state, 'idle');
});

test('start() rejects unknown accounts with status 404 and non-oauth with 400', async () => {
  const { mgr } = makeManager({
    accounts: [{ name: 'api-1', type: 'apikey' }],
    profile: PROFILE_OK,
  });
  await assert.rejects(mgr.start('ghost'), err => err.status === 404);
  await assert.rejects(mgr.start('api-1'), err => err.status === 400);
});

test('browser callback completes the reauth: exchange, persist, reload, done', async () => {
  const { mgr, sessions, persisted, reloads } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await mgr.start('jp@x.com');
  sessions[0].resolveCode('CB-CODE');
  await until(() => mgr.status().state === 'done');
  assert.equal(sessions[0].session.exchanged, 'CB-CODE');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].name, 'jp@x.com');
  assert.equal(persisted[0].creds.accessToken, 'AT');
  assert.equal(reloads(), 1);
  assert.equal(mgr.status().email, 'jp@x.com');
  assert.equal(sessions[0].session.closed, true);
});

test('submitCode() accepts a raw code and completes synchronously', async () => {
  const { mgr, sessions, persisted } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await mgr.start('jp@x.com');
  const st = await mgr.submitCode('PASTED');
  assert.equal(st.state, 'done');
  assert.equal(sessions[0].session.exchanged, 'PASTED');
  assert.equal(persisted.length, 1);
});

test('submitCode() accepts a full callback URL and honours the session state', async () => {
  const { mgr, sessions } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await mgr.start('jp@x.com');
  const st = await mgr.submitCode('http://localhost:9/callback?code=ZZ&state=st');
  assert.equal(st.state, 'done');
  assert.equal(sessions[0].session.exchanged, 'ZZ');
});

test('submitCode() with a wrong-state URL fails the session without persisting', async () => {
  const { mgr, persisted } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await mgr.start('jp@x.com');
  const st = await mgr.submitCode('http://localhost:9/callback?code=ZZ&state=WRONG');
  assert.equal(st.state, 'error');
  assert.match(st.error, /state mismatch/i);
  assert.equal(persisted.length, 0);
});

test('submitCode() with empty input keeps the session pending and throws 400', async () => {
  const { mgr } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await mgr.start('jp@x.com');
  await assert.rejects(mgr.submitCode('   '), err => err.status === 400);
  assert.equal(mgr.status().state, 'pending');
});

test('submitCode() without a pending session throws 409', async () => {
  const { mgr } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await assert.rejects(mgr.submitCode('X'), err => err.status === 409);
});

// ── manager: identity guard ───────────────────────────────────

test('identity mismatch (different accountUuid) errors and persists nothing', async () => {
  const { mgr, persisted, reloads } = makeManager({
    accounts: [OAUTH_ACCT()],
    profile: { accountUuid: 'OTHER', orgUuid: 'o1', email: 'other@y.com' },
  });
  await mgr.start('jp@x.com');
  const st = await mgr.submitCode('CODE');
  assert.equal(st.state, 'error');
  assert.match(st.error, /logged in as other@y\.com/);
  assert.match(st.error, /jp@x\.com/);
  assert.equal(persisted.length, 0);
  assert.equal(reloads(), 0);
});

test('same person, different org fails the guard', async () => {
  const { mgr, persisted } = makeManager({
    accounts: [OAUTH_ACCT()],
    profile: { accountUuid: 'u1', orgUuid: 'OTHER-ORG', orgName: 'Other', email: 'jp@x.com' },
  });
  await mgr.start('jp@x.com');
  const st = await mgr.submitCode('CODE');
  assert.equal(st.state, 'error');
  assert.equal(persisted.length, 0);
});

test('legacy account without stored uuid matches by email and backfills', async () => {
  const { mgr, persisted } = makeManager({
    accounts: [{ name: 'jp@x.com', type: 'oauth' }],
    profile: PROFILE_OK,
  });
  await mgr.start('jp@x.com');
  const st = await mgr.submitCode('CODE');
  assert.equal(st.state, 'done');
  assert.equal(persisted[0].prof.accountUuid, 'u1');
});

test('legacy account without stored uuid rejects a different email', async () => {
  const { mgr, persisted } = makeManager({
    accounts: [{ name: 'jp@x.com', type: 'oauth' }],
    profile: { accountUuid: 'u9', orgUuid: 'o9', email: 'other@y.com' },
  });
  await mgr.start('jp@x.com');
  const st = await mgr.submitCode('CODE');
  assert.equal(st.state, 'error');
  assert.equal(persisted.length, 0);
});

test('profile fetch failure errors the session without persisting', async () => {
  const { mgr, persisted } = makeManager({
    accounts: [OAUTH_ACCT()],
    profile: { error: 'HTTP 500' },
  });
  await mgr.start('jp@x.com');
  const st = await mgr.submitCode('CODE');
  assert.equal(st.state, 'error');
  assert.match(st.error, /HTTP 500/);
  assert.equal(persisted.length, 0);
});

// ── manager: cancellation / timeout / restart ─────────────────

test('cancel() closes the session and returns to idle', async () => {
  const { mgr, sessions } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await mgr.start('jp@x.com');
  mgr.cancel();
  assert.equal(mgr.status().state, 'idle');
  assert.equal(sessions[0].session.closed, true);
});

test('session timeout (codePromise rejection) surfaces as an error state', async () => {
  const { mgr, sessions } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await mgr.start('jp@x.com');
  sessions[0].rejectCode(new Error('Login timed out after 2 minutes'));
  await until(() => mgr.status().state === 'error');
  assert.match(mgr.status().error, /timed out/);
});

test('a second start() cancels the first session', async () => {
  const { mgr, sessions } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await mgr.start('jp@x.com');
  await mgr.start('jp@x.com');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].session.closed, true);
  assert.equal(mgr.status().state, 'pending');
});

test('a late callback from a cancelled session is ignored', async () => {
  const { mgr, sessions, persisted } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await mgr.start('jp@x.com');
  mgr.cancel();
  sessions[0].resolveCode('LATE');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(mgr.status().state, 'idle');
  assert.equal(persisted.length, 0);
});

// ── control endpoints ─────────────────────────────────────────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };

async function withProxy(hooks, fn) {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try { return await fn(port, am); } finally { proxy.close(); }
}

const post = (port, path, body, extraHeaders = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teamclaude-control': '1', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('POST /teamclaude/reauth starts a session via the hook and returns the authUrl', async () => {
  let started = null;
  const reauth = {
    start: async (name) => { started = name; return { authUrl: 'https://claude.ai/oauth/authorize?x=1' }; },
    status: () => ({ state: 'pending', account: 'a', email: null, error: null }),
  };
  await withProxy({ reauth }, async (port) => {
    const res = await post(port, '/teamclaude/reauth', { name: 'a' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.authUrl, 'https://claude.ai/oauth/authorize?x=1');
    assert.equal(started, 'a');
  });
});

test('POST /teamclaude/reauth maps hook errors to their status codes', async () => {
  const reauth = {
    start: async () => { throw Object.assign(new Error('account "ghost" not found'), { status: 404 }); },
  };
  await withProxy({ reauth }, async (port) => {
    const res = await post(port, '/teamclaude/reauth', { name: 'ghost' });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /not found/);
  });
});

test('POST /teamclaude/reauth requires a name (400)', async () => {
  await withProxy({ reauth: { start: async () => ({}) } }, async (port) => {
    assert.equal((await post(port, '/teamclaude/reauth', {})).status, 400);
  });
});

test('POST /teamclaude/reauth/code submits the pasted code and returns the resulting status', async () => {
  let submitted = null;
  const reauth = {
    submitCode: async (code) => { submitted = code; return { state: 'done', account: 'a', email: 'a@x.com', error: null }; },
  };
  await withProxy({ reauth }, async (port) => {
    const res = await post(port, '/teamclaude/reauth/code', { code: 'ZZ' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, 'done');
    assert.equal(submitted, 'ZZ');
  });
});

test('POST /teamclaude/reauth/cancel cancels the pending session', async () => {
  let cancelled = false;
  const reauth = {
    cancel: () => { cancelled = true; },
    status: () => ({ state: 'idle', account: null, email: null, error: null }),
  };
  await withProxy({ reauth }, async (port) => {
    const res = await post(port, '/teamclaude/reauth/cancel');
    assert.equal(res.status, 200);
    assert.equal(cancelled, true);
  });
});

test('GET /teamclaude/reauth reports the current session status', async () => {
  const reauth = { status: () => ({ state: 'pending', account: 'a', email: null, error: null }) };
  await withProxy({ reauth }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reauth`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.state, 'pending');
    assert.equal(data.account, 'a');
  });
});

test('reauth endpoints return 501 when the hook is not wired', async () => {
  await withProxy({}, async (port) => {
    assert.equal((await post(port, '/teamclaude/reauth', { name: 'a' })).status, 501);
    assert.equal((await post(port, '/teamclaude/reauth/code', { code: 'x' })).status, 501);
    assert.equal((await post(port, '/teamclaude/reauth/cancel')).status, 501);
    assert.equal((await fetch(`http://127.0.0.1:${port}/teamclaude/reauth`)).status, 501);
  });
});

test('mutating reauth endpoints are CSRF-guarded (403 for a cross-origin page)', async () => {
  // The guard is the shared same-origin check on every POST /teamclaude/*:
  // Origin / Sec-Fetch-Site are browser-set and unforgeable from page JS, so a
  // page on another site is refused while curl and the CLI (no such headers)
  // and the same-origin dashboard pass.
  let started = false;
  const reauth = { start: async () => { started = true; return { authUrl: 'x' }; } };
  await withProxy({ reauth }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reauth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ name: 'a' }),
    });
    assert.equal(res.status, 403);
    assert.equal(started, false);
  });
});

test('strict start (client key or SSO) refuses an entry with no identity to check; the operator may', async () => {
  const legacy = () => ({ name: 'seat6', type: 'oauth' });
  const { mgr } = makeManager({ accounts: [legacy()], profile: PROFILE_OK });
  await assert.rejects(mgr.start('seat6', { strict: true }), (e) => e.status === 403 && /no stored identity/.test(e.message));
  assert.equal(mgr.status().state, 'idle', 'nothing started');
  // Strict still reauths an account it can check.
  const { mgr: m2 } = makeManager({ accounts: [OAUTH_ACCT(), { name: 'old@x.com', type: 'oauth' }], profile: PROFILE_OK });
  assert.ok((await m2.start('jp@x.com', { strict: true })).authUrl);
  assert.ok((await m2.start('old@x.com', { strict: true })).authUrl, 'an email-shaped name is checked by email');
  // The key-holding operator keeps the old behaviour.
  const { mgr: m3 } = makeManager({ accounts: [legacy()], profile: PROFILE_OK });
  assert.ok((await m3.start('seat6')).authUrl);
});

test('a client key cannot replace, cancel or fail a reauth the operator started; the operator and the owner can', async () => {
  const { OPERATOR } = await import('../src/reauth.js');
  const { mgr, sessions } = makeManager({ accounts: [OAUTH_ACCT(), { name: 'b@x.com', type: 'oauth', accountUuid: 'u2' }], profile: PROFILE_OK });
  await mgr.start('jp@x.com'); // the operator (default owner)
  const lane = { owner: 'client:familiar' };
  await assert.rejects(mgr.start('b@x.com', lane), (e) => e.status === 409 && /started by the operator/.test(e.message), 'no superseding');
  assert.throws(() => mgr.cancel(lane), (e) => e.status === 409, 'no cancelling');
  await assert.rejects(mgr.submitCode('https://x/cb?code=c&state=WRONG', lane), (e) => e.status === 409, 'no failing it with a wrong-state code');
  assert.equal(mgr.status().state, 'pending');
  assert.equal(mgr.status().account, 'jp@x.com');
  assert.equal(sessions[0].session.closed, false, 'the operator\'s session is untouched');
  // The owner (here the operator) still can.
  mgr.cancel({ owner: OPERATOR });
  assert.equal(mgr.status().state, 'idle');
  // A client may replace and cancel its OWN session; the operator may replace a client's.
  await mgr.start('b@x.com', lane);
  await mgr.start('b@x.com', lane);
  await mgr.start('jp@x.com');
  assert.equal(mgr.status().account, 'jp@x.com');
  // Another client cannot touch the first client's either.
  mgr.cancel();
  await mgr.start('b@x.com', lane);
  await assert.rejects(mgr.start('jp@x.com', { owner: 'client:other' }), (e) => e.status === 409 && /another client/.test(e.message));
  mgr.cancel(lane);
  assert.equal(mgr.status().state, 'idle');
  // A finished session no longer blocks anyone.
  await mgr.start('jp@x.com');
  await mgr.submitCode('code-ok');
  assert.equal(mgr.status().state, 'done');
  assert.ok((await mgr.start('b@x.com', lane)).authUrl);
});

/** A manager whose createSession waits until the test releases it: deterministic races. */
function deferredManager() {
  const gates = [];
  const made = [];
  const mgr = createReauthManager({
    accountManager: { accounts: [OAUTH_ACCT(), { name: 'b@x.com', type: 'oauth', accountUuid: 'u2' }] },
    createSession: () => new Promise((resolve) => {
      gates.push(() => { const s = fakeSession(); made.push(s); resolve(s.session); });
    }),
    fetchProfileFn: async () => PROFILE_OK,
    persistTokens: async () => {},
    reload: async () => {},
    log: () => {},
  });
  const tick = () => new Promise((r) => setImmediate(r));
  return { mgr, gates, made, tick };
}

test('race: a client start still creating its session cannot overwrite the operator\'s newer one', async () => {
  const { mgr, gates, made, tick } = deferredManager();
  const lane = { owner: 'client:familiar' };
  // The client starts first and stalls in createSession…
  const clientStart = mgr.start('b@x.com', lane);
  await tick();
  // …the operator starts after it (allowed: the operator may replace anyone)…
  const opStart = mgr.start('jp@x.com');
  await tick();
  gates[1](); // the operator's session is created first
  await opStart;
  gates[0](); // then the client's arrives late
  await assert.rejects(clientStart, (e) => e.status === 409);
  assert.equal(mgr.status().account, 'jp@x.com', 'the operator\'s session stands');
  assert.equal(made[1].session.closed, true, 'the late session was closed, not left open');
});

test('race: while the operator\'s start is creating its session, a client cannot start or cancel', async () => {
  const { mgr, gates, tick } = deferredManager();
  const lane = { owner: 'client:familiar' };
  const opStart = mgr.start('jp@x.com');
  await tick();
  await assert.rejects(mgr.start('b@x.com', lane), (e) => e.status === 409 && /the operator/.test(e.message));
  assert.throws(() => mgr.cancel(lane), (e) => e.status === 409);
  gates[0]();
  await opStart;
  assert.equal(mgr.status().account, 'jp@x.com');
});

test('race: an operator cancel invalidates a client start that is still creating its session', async () => {
  const { mgr, gates, made, tick } = deferredManager();
  const clientStart = mgr.start('b@x.com', { owner: 'client:familiar' });
  await tick();
  mgr.cancel(); // the operator
  gates[0]();
  await assert.rejects(clientStart, (e) => e.status === 409);
  assert.equal(mgr.status().state, 'idle', 'nothing was published after the cancel');
  assert.equal(made[0].session.closed, true);
});

test('a client cannot clear the result of the operator\'s finished reauth', async () => {
  const { mgr } = makeManager({ accounts: [OAUTH_ACCT()], profile: PROFILE_OK });
  await mgr.start('jp@x.com');
  await mgr.submitCode('code-ok');
  assert.equal(mgr.status().state, 'done');
  assert.throws(() => mgr.cancel({ owner: 'client:familiar' }), (e) => e.status === 409);
  assert.equal(mgr.status().state, 'done', 'the operator still sees the result');
});

test('the localhost callback ignores a wrong or missing state: the pending sign-in is not failed', async () => {
  const { startCallbackServer } = await import('../src/oauth.js');
  const { port, codePromise, server } = await startCallbackServer('the-real-state');
  try {
    let settled = false;
    codePromise.then(() => { settled = true; }, () => { settled = true; });
    for (const q of ['?state=wrong&code=x', '?code=x', '?state=wrong&error=access_denied']) {
      const r = await fetch(`http://127.0.0.1:${port}/callback${q}`);
      assert.equal(r.status, 400, q);
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settled, false, 'still waiting for the real approval');
    const ok = await fetch(`http://127.0.0.1:${port}/callback?state=the-real-state&code=good`, { redirect: 'manual' });
    assert.equal(ok.status, 302);
    assert.equal(await codePromise, 'good');
  } finally { server.close(); }
});
