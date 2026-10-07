import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, forwardHeaders } from '../src/server.js';
import { allowLoopbackForward } from '../src/forward-target.js';

// A plain-HTTP forward (HTTP_PROXY, `GET http://third-party/…`) relays the
// client's own headers to the target — and used to relay the credential the
// client presented to THIS proxy along with them: a keyed client fetching any
// http:// URL handed its proxy key to that host (2026-10-07, found by the
// ubox0 lane). The target is a canary that records what it was sent.

const SHARED = 'test-shared-proxy-key-0001';
const CLIENT = 'test-client-proxy-key-0002';
const PROXY = { apiKey: SHARED, clientKeys: [{ name: 'alice', key: CLIENT }] };
const ACCOUNT_TOKEN = 'test-account-token-must-not-leak';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function proxyGet(proxyPort, absoluteUrl, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: absoluteUrl, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withCanary(fn) {
  const seen = [];
  const canary = http.createServer((req, res) => { seen.push(req.headers); res.end('ok'); });
  const canaryPort = await listen(canary);
  const am = new AccountManager([{ name: 'acct', type: 'apikey', apiKey: ACCOUNT_TOKEN }], 0.98);
  const proxy = createProxyServer(am, { proxy: PROXY, upstream: 'http://127.0.0.1:9' });
  allowLoopbackForward(proxy); // the canary stands in for a remote host but lives on 127.0.0.1
  const proxyPort = await listen(proxy);
  try { return await fn({ proxyPort, url: `http://127.0.0.1:${canaryPort}/x`, seen }); } finally { proxy.close(); canary.close(); }
}

const secretsIn = (headers) => {
  const all = JSON.stringify(headers);
  return [SHARED, CLIENT, ACCOUNT_TOKEN].filter((s) => all.includes(s));
};

test('a keyed client\'s proxy credentials never reach a plain-HTTP forward target', async () => {
  await withCanary(async ({ proxyPort, url, seen }) => {
    for (const [label, headers] of [
      ['x-api-key (client key)', { 'x-api-key': CLIENT }],
      ['x-api-key (shared key)', { 'x-api-key': SHARED }],
      ['x-api-key + Bearer proxy key', { 'x-api-key': CLIENT, authorization: `Bearer ${SHARED}` }],
      ['x-api-key + bare proxy key in authorization', { 'x-api-key': CLIENT, authorization: CLIENT }],
      ['x-api-key + Proxy-Authorization', { 'x-api-key': CLIENT, 'proxy-authorization': `Bearer ${CLIENT}` }],
      ['x-api-key + Basic Proxy-Authorization', { 'x-api-key': CLIENT, 'proxy-authorization': `Basic ${Buffer.from(`${CLIENT}:`).toString('base64')}` }],
    ]) {
      seen.length = 0;
      assert.equal(await proxyGet(proxyPort, url, { ...headers, 'x-trace': label }), 200, label);
      assert.equal(seen.length, 1, label);
      const got = seen[0];
      assert.equal(got['x-trace'], label, 'ordinary headers still pass');
      assert.equal(got['x-api-key'], undefined, label);
      assert.equal(got['proxy-authorization'], undefined, label);
      assert.equal(got.authorization, undefined, label);
      assert.deepEqual(secretsIn(got), [], `${label}: no proxy key or account token anywhere in what the target saw`);
    }
  });
});

test('the client\'s own credential for the target still passes; no account credential is added', async () => {
  await withCanary(async ({ proxyPort, url, seen }) => {
    assert.equal(await proxyGet(proxyPort, url, { 'x-api-key': CLIENT, authorization: 'Bearer target-service-token' }), 200);
    assert.equal(seen[0].authorization, 'Bearer target-service-token');
    assert.deepEqual(secretsIn(seen[0]), []);
    // Loopback with no key at all: nothing credential-shaped appears from the proxy.
    seen.length = 0;
    assert.equal(await proxyGet(proxyPort, url, {}), 200);
    assert.equal(seen[0].authorization, undefined);
    assert.equal(seen[0]['x-api-key'], undefined);
    assert.deepEqual(secretsIn(seen[0]), []);
  });
});

test('forwardHeaders: strips proxy credentials case-insensitively, keeps the rest', () => {
  const out = forwardHeaders({
    'x-api-key': 'anything', authorization: `bearer   ${CLIENT} `, 'proxy-authorization': 'x', connection: 'keep-alive',
    host: 'h', 'proxy-connection': 'keep-alive', accept: 'text/plain',
  }, PROXY);
  assert.deepEqual(out, { accept: 'text/plain' });
  // With no keys configured, a client's Authorization is never mistaken for one.
  assert.deepEqual(forwardHeaders({ authorization: 'Bearer t', 'x-api-key': 'k' }, {}), { authorization: 'Bearer t' });
  assert.deepEqual(forwardHeaders({ authorization: '' }, PROXY), { authorization: '' });
});

test('forwardHeaders: a proxy key hidden in Basic, a joined value, an array, or tab-separated Bearer is caught', () => {
  const b64 = (s) => Buffer.from(s).toString('base64');
  for (const value of [
    `Basic ${b64(`${CLIENT}:`)}`,
    `Basic ${b64(`user:${SHARED}`)}`,
    `basic ${b64(CLIENT)}`,
    `Bearer\t${CLIENT}`,
    `Bearer ${SHARED}, Bearer target-token`,
    `Bearer target-token, ${CLIENT}`,
    ['Bearer target-token', `Bearer ${CLIENT}`],
  ]) {
    assert.deepEqual(forwardHeaders({ authorization: value, accept: 'a' }, PROXY), { accept: 'a' }, JSON.stringify(value));
  }
  // The client's own Basic/Bearer for the target is untouched.
  for (const value of [`Basic ${b64('me:target-pass')}`, 'Bearer target-token, Bearer other']) {
    assert.deepEqual(forwardHeaders({ authorization: value }, PROXY), { authorization: value });
  }
});

test('forwardHeaders: headers the Connection header nominates are dropped', () => {
  assert.deepEqual(
    forwardHeaders({ connection: 'keep-alive, X-Internal-Control', 'x-internal-control': '1', accept: 'a' }, PROXY),
    { accept: 'a' },
  );
});

test('end to end: Basic and joined forms are dropped before the target sees them', async () => {
  await withCanary(async ({ proxyPort, url, seen }) => {
    for (const authorization of [
      `Basic ${Buffer.from(`u:${CLIENT}`).toString('base64')}`,
      `Bearer ${SHARED}, Bearer target-token`,
    ]) {
      seen.length = 0;
      assert.equal(await proxyGet(proxyPort, url, { 'x-api-key': CLIENT, authorization }), 200);
      assert.equal(seen[0].authorization, undefined, authorization);
      assert.deepEqual(secretsIn(seen[0]), []);
    }
  });
});
