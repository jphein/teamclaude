import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAddAccountManager } from '../src/add-account.js';
import { createReauthManager } from '../src/reauth.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function fakeSession() {
  let resolveCode, rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  codePromise.catch(() => {});
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

function makeManager({ save, otherSessionPending } = {}) {
  const sessions = [];
  const saved = [];
  let reloads = 0;
  const mgr = createAddAccountManager({
    createSession: async () => { const s = fakeSession(); sessions.push(s); return s.session; },
    saveAccount: save || (async (creds, name) => { saved.push({ creds, name }); return { action: 'added', name: name || 'jp@x.com' }; }),
    reload: async () => { reloads++; },
    otherSessionPending,
    log: () => {},
  });
  return { mgr, sessions, saved, reloads: () => reloads };
}

async function until(fn, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('condition not reached in time');
}

test('status() is idle before any start; start() opens a pending session', async () => {
  const { mgr } = makeManager();
  assert.equal(mgr.status().state, 'idle');
  const { authUrl } = await mgr.start();
  assert.match(authUrl, /^https:\/\/claude\.ai/);
  assert.equal(mgr.status().state, 'pending');
  assert.equal(mgr.status().name, null);
  assert.equal(mgr.pending(), true);
});

test('browser callback completes: exchange, save (unnamed), reload, done', async () => {
  const { mgr, sessions, saved, reloads } = makeManager();
  await mgr.start();
  sessions[0].resolveCode('CB-CODE');
  await until(() => mgr.status().state === 'done');
  assert.equal(sessions[0].session.exchanged, 'CB-CODE');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, null);
  assert.equal(reloads(), 1);
  assert.equal(mgr.status().name, 'jp@x.com');
  assert.equal(mgr.status().action, 'added');
  assert.equal(sessions[0].session.closed, true);
});

test('a requested name is passed through to the save, trimmed; blank means unnamed', async () => {
  const { mgr, sessions, saved } = makeManager();
  await mgr.start({ name: '  claude5 ' });
  assert.equal(mgr.status().name, 'claude5');
  sessions[0].resolveCode('C');
  await until(() => mgr.status().state === 'done');
  assert.equal(saved[0].name, 'claude5');

  const m2 = makeManager();
  await m2.mgr.start({ name: '   ' });
  assert.equal(m2.mgr.status().name, null);
});

test('pasted code completes the session and returns the final status', async () => {
  const { mgr, sessions } = makeManager();
  await mgr.start();
  const st = await mgr.submitCode('PASTED');
  assert.equal(st.state, 'done');
  assert.equal(sessions[0].session.exchanged, 'PASTED');
});

test('a save that throws (unidentifiable profile) fails the session with its message', async () => {
  const { mgr, sessions, reloads } = makeManager({
    save: async () => { throw new Error('Could not identify OAuth account — profile unavailable. Retry…'); },
  });
  await mgr.start();
  sessions[0].resolveCode('X');
  await until(() => mgr.status().state === 'error');
  assert.match(mgr.status().error, /Could not identify/);
  assert.equal(reloads(), 0);
  assert.equal(sessions[0].session.closed, true);
});

test('start() refuses with 409 while a reauth is pending, and vice versa', async () => {
  const reauth = createReauthManager({
    accountManager: { accounts: [{ name: 'a', type: 'oauth' }] },
    createSession: async () => fakeSession().session,
    persistTokens: async () => {},
    reload: async () => {},
    otherSessionPending: () => add.pending(),
    log: () => {},
  });
  const add = createAddAccountManager({
    createSession: async () => fakeSession().session,
    saveAccount: async () => ({ action: 'added', name: 'n' }),
    reload: async () => {},
    otherSessionPending: () => reauth.pending(),
    log: () => {},
  });
  await reauth.start('a');
  await assert.rejects(add.start(), err => err.status === 409);
  reauth.cancel();
  await add.start();
  await assert.rejects(reauth.start('a'), err => err.status === 409);
  add.cancel();
  assert.equal(add.status().state, 'idle');
});

test('submitCode with nothing pending is a 409; a bad paste fails the session', async () => {
  const { mgr } = makeManager();
  await assert.rejects(mgr.submitCode('x'), err => err.status === 409);
  await mgr.start();
  const st = await mgr.submitCode('https://console.anthropic.com/oauth/code/callback?code=Q&state=WRONG');
  assert.equal(st.state, 'error');
});

// ── routes ────────────────────────────────────────────────────

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };

async function withProxy(hooks, fn) {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  try { return await fn(port); } finally { proxy.close(); }
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teamclaude-control': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('POST /teamclaude/add-account starts a session and returns the authUrl; GET polls', async () => {
  let started = null;
  const addAccount = {
    start: async (opts) => { started = opts; return { authUrl: 'https://claude.ai/oauth/authorize?x=1' }; },
    status: () => ({ state: 'pending', name: 'claude5', email: null, action: null, error: null }),
  };
  await withProxy({ addAccount }, async (port) => {
    const res = await post(port, '/teamclaude/add-account', { name: 'claude5' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).authUrl, 'https://claude.ai/oauth/authorize?x=1');
    assert.deepEqual(started, { name: 'claude5' });
    const g = await fetch(`http://127.0.0.1:${port}/teamclaude/add-account`);
    assert.equal((await g.json()).state, 'pending');
  });
});

test('POST /teamclaude/add-account rejects a non-string name (400) and maps hook errors', async () => {
  const addAccount = { start: async () => { throw Object.assign(new Error('busy'), { status: 409 }); } };
  await withProxy({ addAccount }, async (port) => {
    assert.equal((await post(port, '/teamclaude/add-account', { name: 5 })).status, 400);
    assert.equal((await post(port, '/teamclaude/add-account', {})).status, 409);
  });
});

test('POST /teamclaude/add-account/code and /cancel reach the hook', async () => {
  let submitted = null, cancelled = false;
  const addAccount = {
    submitCode: async (code) => { submitted = code; return { state: 'done', name: 'n', action: 'added', error: null }; },
    cancel: () => { cancelled = true; },
    status: () => ({ state: 'idle' }),
  };
  await withProxy({ addAccount }, async (port) => {
    const res = await post(port, '/teamclaude/add-account/code', { code: 'ZZ' });
    assert.equal((await res.json()).state, 'done');
    assert.equal(submitted, 'ZZ');
    await post(port, '/teamclaude/add-account/cancel');
    assert.equal(cancelled, true);
  });
});

test('routes answer 501 when the hook is absent', async () => {
  await withProxy({}, async (port) => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/teamclaude/add-account`)).status, 501);
    assert.equal((await post(port, '/teamclaude/add-account', {})).status, 501);
  });
});
