import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

// Spin up an HTTP server on an ephemeral port and return { server, port, url }.
async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, port, url: `http://127.0.0.1:${port}` };
}

// Make a request to the proxy. Resolves with { status, body } on a real HTTP
// response, or rejects with the socket error (e.g. ECONNRESET) if the proxy
// destroys the connection.
function clientRequest(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'x', max_tokens: 1, messages: [] }));
  });
}

function apiKeyManager() {
  // apikey type → ensureTokenFresh() is a no-op, so the test makes zero
  // network calls beyond the local mock upstream.
  return new AccountManager([{ name: 'test', type: 'apikey', apiKey: 'sk-test' }], 0.98);
}

// POST an arbitrary JSON body + headers to /v1/messages and resolve the response.
function postJson(port, bodyObj, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', ...extraHeaders } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(bodyObj));
  });
}

test('transient upstream failure is retried, not dropped on the client', async (t) => {
  let hits = 0;
  const up = await listen((req, res) => {
    hits++;
    if (hits === 1) {
      // Simulate a stale-keep-alive / transient connection failure: kill the
      // socket with no response so the proxy's fetch() throws "fetch failed".
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hits }));
  });

  const proxy = createProxyServer(apiKeyManager(), { upstream: up.url, proxy: {} });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.close(); up.server.close(); });

  const result = await clientRequest(proxy.address().port);

  assert.equal(result.status, 200, 'client should get a 200 after the proxy retries the transient failure');
  assert.equal(JSON.parse(result.body).ok, true);
  assert.equal(hits, 2, 'upstream should have been hit twice (1 transient failure + 1 success)');
});

test('persistent upstream failure returns a clean 502, never a destroyed socket', async (t) => {
  const up = await listen((req) => { req.socket.destroy(); }); // always fails

  const proxy = createProxyServer(apiKeyManager(), { upstream: up.url, proxy: {} });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.close(); up.server.close(); });

  const result = await clientRequest(proxy.address().port); // must resolve, not reject
  assert.equal(result.status, 502, 'exhausted retries should yield a 502, not a dropped connection');
  const body = JSON.parse(result.body);
  assert.equal(body.type, 'error');
});

function twoApiKeys() {
  return new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'sk-a' },
    { name: 'b', type: 'apikey', apiKey: 'sk-b' },
  ], 0.98);
}

// 429 behavior tests superseded by upstream's bounded-retry strategy
// (see test/server-retry.test.js for the upstream 429 tests)

// Fast mode (/fast) bills as usage credits, not subscription quota, so it 429s
// on every account regardless of quota. Stripping it upstream stops one /fast
// keystroke from rate-limiting the whole pool (see stripFastMode in server.js).
test('fast mode (speed:"fast") is stripped before forwarding upstream', { timeout: 4000 }, async (t) => {
  let received = null;
  let receivedBeta;
  const up = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString());
      receivedBeta = req.headers['anthropic-beta'];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const proxy = createProxyServer(apiKeyManager(), { upstream: up.url, proxy: {} });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.close(); up.server.close(); });

  const result = await postJson(
    proxy.address().port,
    { model: 'claude-opus-4-8', max_tokens: 1, messages: [], speed: 'fast' },
    { 'anthropic-beta': 'oauth-2025-04-20,fast-mode-2026-02-01' },
  );

  assert.equal(result.status, 200, 'stripped request runs as standard Opus and succeeds');
  assert.ok(received, 'upstream should have received the forwarded request');
  assert.equal(received.speed, undefined, 'speed:"fast" must be stripped from the body');
  assert.equal(received.model, 'claude-opus-4-8', 'the rest of the body is preserved');
  assert.ok(!/fast-mode/.test(receivedBeta ?? ''), 'fast-mode beta token must be stripped');
  assert.ok(/oauth-2025-04-20/.test(receivedBeta ?? ''), 'unrelated beta tokens must survive');
});

// A normal (non-fast) request must pass through completely untouched.
test('non-fast requests are forwarded unchanged', { timeout: 4000 }, async (t) => {
  let received = null;
  const up = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const proxy = createProxyServer(apiKeyManager(), { upstream: up.url, proxy: {} });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.close(); up.server.close(); });

  const result = await postJson(proxy.address().port, { model: 'claude-opus-4-8', max_tokens: 1, messages: [] });

  assert.equal(result.status, 200);
  assert.deepEqual(received, { model: 'claude-opus-4-8', max_tokens: 1, messages: [] });
});
