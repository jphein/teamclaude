import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };
const ACCTS = () => [
  { name: 'a', type: 'apikey', apiKey: 'k1' },
  { name: 'b', type: 'apikey', apiKey: 'k2' },
];

async function withProxy(hooks, fn) {
  const am = new AccountManager(ACCTS(), 0.98);
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

test('GET /ui serves the dashboard HTML', async () => {
  await withProxy({}, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/ui`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /TeamClaude/);
  });
});

test('POST /teamclaude/switch pins the account by name', async () => {
  await withProxy({}, async (port, am) => {
    const res = await post(port, '/teamclaude/switch', { account: 'b' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).currentAccount, 'b');
    assert.equal(am.currentIndex, 1);
  });
});

test('POST /teamclaude/switch 404s an unknown account and 400s a missing one', async () => {
  await withProxy({}, async (port) => {
    assert.equal((await post(port, '/teamclaude/switch', { account: 'nope' })).status, 404);
    assert.equal((await post(port, '/teamclaude/switch', {})).status, 400);
  });
});

test('POST /teamclaude/threshold applies live and calls the persist hook', async () => {
  let persisted = null;
  await withProxy({ persistThreshold: (v) => { persisted = v; } }, async (port, am) => {
    const res = await post(port, '/teamclaude/threshold', { value: 0.8 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).switchThreshold, 0.8);
    assert.equal(am.switchThreshold, 0.8);
    assert.equal(persisted, 0.8);
  });
});

test('POST /teamclaude/threshold rejects out-of-range values', async () => {
  await withProxy({}, async (port) => {
    assert.equal((await post(port, '/teamclaude/threshold', { value: 1.5 })).status, 400);
    assert.equal((await post(port, '/teamclaude/threshold', { value: 'x' })).status, 400);
  });
});

test('POST /teamclaude/account disables live and persists', async () => {
  let persisted = null;
  await withProxy({ persistAccountDisabled: (name, d) => { persisted = { name, d }; } }, async (port, am) => {
    const res = await post(port, '/teamclaude/account', { name: 'a', disabled: true });
    assert.equal(res.status, 200);
    assert.equal(am.accounts[0].disabled, true);
    assert.deepEqual(persisted, { name: 'a', d: true });
  });
});

test('POST /teamclaude/account 404s an unknown account', async () => {
  await withProxy({}, async (port) => {
    assert.equal((await post(port, '/teamclaude/account', { name: 'ghost', disabled: true })).status, 404);
  });
});

test('POST /teamclaude/probe runs the probe hook; 501 when unwired', async () => {
  await withProxy({ probeNow: async () => 3 }, async (port) => {
    const res = await post(port, '/teamclaude/probe');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, probed: 3 });
  });
  await withProxy({}, async (port) => {
    assert.equal((await post(port, '/teamclaude/probe')).status, 501);
  });
});

test('mutating endpoints reject requests without the CSRF header (403)', async () => {
  await withProxy({ persistThreshold: () => {} }, async (port, am) => {
    // No x-teamclaude-control header → blocked before any state change.
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/threshold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.5 }),
    });
    assert.equal(res.status, 403);
    assert.equal(am.switchThreshold, 0.98); // unchanged — the mutation never ran
  });
});

test('GET /teamclaude/status exposes per-account inFlight and the server block', async () => {
  await withProxy({ getStatusExtra: () => ({ server: { version: '9.9.9', port: 1234 } }) }, async (port) => {
    const data = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json();
    assert.ok(Array.isArray(data.accounts));
    assert.equal(data.accounts[0].inFlight, 0);
    assert.equal(data.server.version, '9.9.9');
  });
});

test('GET /teamclaude/activity is an SSE stream that replays terminal events', async () => {
  await withProxy({}, async (port) => {
    // Emit a terminal event into the ring buffer first.
    await post(port, '/teamclaude/switch', { account: 'b' });
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/activity`, { signal: ctrl.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const { value } = await res.body.getReader().read();
    ctrl.abort();
    const chunk = new TextDecoder().decode(value);
    assert.match(chunk, /"type":"switched"/);
    assert.match(chunk, /"account":"b"/);
  });
});
