import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUiTicketStore } from '../src/ui-ticket.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The desktop launcher's way into /ui (2026-10-25): the key never travels in a
// URL; a one-time ticket does, and the page trades it for the key at boot.

test('a ticket redeems once for the key that minted it, then never again', () => {
  const store = createUiTicketStore();
  const t = store.mint('shared-k');
  assert.match(t, /^[A-Za-z0-9_-]{43}$/, '256 random bits, base64url');
  assert.equal(store.redeem(t), 'shared-k');
  assert.equal(store.redeem(t), null);
});

test('a ticket past its lifetime redeems for nothing, and is gone', () => {
  let now = 1_000_000;
  const store = createUiTicketStore({ now: () => now, ttlMs: 60_000 });
  const t = store.mint('k');
  now += 60_001;
  assert.equal(store.redeem(t), null);
  assert.equal(store.size, 0);
});

test('outstanding tickets are capped, and expired ones free their slots', () => {
  let now = 0;
  const store = createUiTicketStore({ now: () => now, max: 2 });
  assert.ok(store.mint('k'));
  assert.ok(store.mint('k'));
  assert.equal(store.mint('k'), null);
  now += 60_001;
  assert.ok(store.mint('k'));
});

test('anything but a plausible ticket string redeems for nothing', () => {
  const store = createUiTicketStore();
  store.mint('k');
  for (const bad of [undefined, null, 42, {}, '', 'short', 'x'.repeat(129)]) assert.equal(store.redeem(bad), null);
});

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

async function server() {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'shared-k', clientKeys: [{ name: 'lane', key: 'k-lane' }] }, upstream: 'https://api.anthropic.com' });
  const port = await listen(proxy);
  const post = (path, { headers = {}, body } = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? '' : JSON.stringify(body),
  });
  return { proxy, port, post };
}

test('the operator key mints a ticket; a client key is refused; a key-less loopback caller has nothing to hand over', async () => {
  const { proxy, post } = await server();
  try {
    const ok = await post('/teamclaude/ui-ticket', { headers: { 'x-api-key': 'shared-k' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.ok((await ok.json()).ticket);
    assert.equal((await post('/teamclaude/ui-ticket', { headers: { 'x-api-key': 'k-lane' } })).status, 403);
    assert.equal((await post('/teamclaude/ui-ticket')).status, 400);
  } finally { proxy.close(); }
});

test('the page redeems a ticket without a key, exactly once, for the key that minted it', async () => {
  const { proxy, post } = await server();
  try {
    const { ticket } = await (await post('/teamclaude/ui-ticket', { headers: { 'x-api-key': 'shared-k' } })).json();
    const first = await post('/teamclaude/ui-ticket/redeem', { headers: { 'sec-fetch-site': 'same-origin' }, body: { ticket } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal((await first.json()).key, 'shared-k');
    assert.equal((await post('/teamclaude/ui-ticket/redeem', { body: { ticket } })).status, 404, 'spent');
    assert.equal((await post('/teamclaude/ui-ticket/redeem', { body: { ticket: 'A'.repeat(43) } })).status, 404, 'never minted');
  } finally { proxy.close(); }
});

test('a cross-origin page cannot redeem, and its attempt does not spend the ticket', async () => {
  const { proxy, post } = await server();
  try {
    const { ticket } = await (await post('/teamclaude/ui-ticket', { headers: { 'x-api-key': 'shared-k' } })).json();
    const evil = await post('/teamclaude/ui-ticket/redeem', { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: { ticket } });
    assert.equal(evil.status, 403);
    assert.equal((await post('/teamclaude/ui-ticket/redeem', { body: { ticket } })).status, 200, 'still redeemable by the page');
  } finally { proxy.close(); }
});

test('/ui is served with no referrer, so a ticket in the address bar cannot leak through a link', async () => {
  const { proxy, port } = await server();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ui`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const html = await res.text();
    assert.match(html, /searchParams\.delete\('ticket'\)/, 'the page strips the ticket from the address bar');
  } finally { proxy.close(); }
});

test('a cross-origin page cannot mint a ticket even with the operator key', async () => {
  const { proxy, post } = await server();
  try {
    const res = await post('/teamclaude/ui-ticket', { headers: { 'x-api-key': 'shared-k', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.status, 403);
  } finally { proxy.close(); }
});

test('two redemptions racing for one ticket: exactly one gets the key', async () => {
  const { proxy, post } = await server();
  try {
    const { ticket } = await (await post('/teamclaude/ui-ticket', { headers: { 'x-api-key': 'shared-k' } })).json();
    const res = await Promise.all([1, 2, 3].map(() => post('/teamclaude/ui-ticket/redeem', { body: { ticket } })));
    assert.deepEqual(res.map(r => r.status).sort(), [200, 404, 404]);
  } finally { proxy.close(); }
});

// Oracle (2026-10-25): the launcher opens /ui WITH a query string; the route
// once matched the exact URL, so this address fell through to the gate.
test('/ui?ticket=… serves the page itself, with no referrer, to a remote and a loopback caller alike', async () => {
  let upstreamHits = 0;
  const upstream = (await import('node:http')).createServer((req, res) => { upstreamHits++; res.end('upstream'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'shared-k' }, upstream: `http://127.0.0.1:${upPort}` });
  const port = await listen(proxy);
  try {
    for (const headers of [{}, { 'x-forwarded-for': '10.0.6.158' }]) {
      const res = await fetch(`http://127.0.0.1:${port}/ui?ticket=${'T'.repeat(43)}`, { headers });
      assert.equal(res.status, 200, JSON.stringify(headers));
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.match(await res.text(), /launchTicket/);
    }
    assert.equal(upstreamHits, 0, 'the ticket never travels upstream');
  } finally { proxy.close(); upstream.close(); }
});

test('with no keys configured there is nothing to hand over: no ticket is minted', async () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }], 0.98);
  const proxy = createProxyServer(am, { upstream: 'https://api.anthropic.com' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/ui-ticket`, { method: 'POST', headers: { 'x-api-key': 'anything' } });
    assert.equal(res.status, 400);
  } finally { proxy.close(); }
});
