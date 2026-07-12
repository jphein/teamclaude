import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };
const ACCTS = [
  { name: 'a@x.org', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  { name: 'b@x.org', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
];

// ── POST /teamclaude/probe — on-demand quota refresh ────────

test('POST /teamclaude/probe runs the probe hook and reports the count', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  let probed = 0;
  const proxy = createProxyServer(am, CONFIG, { probeNow: async () => { probed++; return 2; } });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/probe`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.probed, 2);
    assert.equal(probed, 1);
  } finally {
    proxy.close();
  }
});

test('probe returns 501 when no probe hook is wired', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/probe`, { method: 'POST' });
    assert.equal(res.status, 501);
  } finally {
    proxy.close();
  }
});

// ── POST /teamclaude/account — enable/disable from the UI ───

test('POST /teamclaude/account disables an account live and persists via hook', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const persisted = [];
  const proxy = createProxyServer(am, CONFIG, {
    persistAccountDisabled: async (name, disabled) => { persisted.push([name, disabled]); },
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'b@x.org', disabled: true }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.name, 'b@x.org');
    assert.equal(body.disabled, true);
    assert.equal(am.accounts[1].disabled, true);         // applied live
    assert.deepEqual(persisted, [['b@x.org', true]]);    // persisted to config
  } finally {
    proxy.close();
  }
});

test('re-enabling via /teamclaude/account clears a stuck error state', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  am.accounts[0].status = 'error';
  const proxy = createProxyServer(am, CONFIG, { persistAccountDisabled: async () => {} });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a@x.org', disabled: false }),
    });
    assert.equal(res.status, 200);
    assert.equal(am.accounts[0].status, 'active');
  } finally {
    proxy.close();
  }
});

test('unknown account name returns 404', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, CONFIG, { persistAccountDisabled: async () => {} });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nobody@x.org', disabled: true }),
    });
    assert.equal(res.status, 404);
  } finally {
    proxy.close();
  }
});

// ── GET /teamclaude/status — server block for the UI panel ──

test('status includes a server block with version, uptime, pid, and memory', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, CONFIG, {}, null, { version: '1.1.0' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    const body = await res.json();
    assert.equal(body.server.version, '1.1.0');
    assert.equal(typeof body.server.uptimeSeconds, 'number');
    assert.equal(body.server.pid, process.pid);
    assert.ok(body.server.rssBytes > 0);
  } finally {
    proxy.close();
  }
});
