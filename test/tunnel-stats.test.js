import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { allowLoopbackForward } from '../src/forward-target.js';
import { TunnelStats } from '../src/tunnel-stats.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

// Blind tunnels per client, open now and at peak (2026-10-21: an osv.dev burst
// exhausted the proxy's file descriptors). The numbers feed a per-client cap,
// so they have to be right: counted from the dial, released exactly once.

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

test('TunnelStats: active, peak since start, 24 h peak; close is idempotent', () => {
  let now = 10 * 3_600_000;
  const st = new TunnelStats(() => now);
  const a = st.open('familiar'); const b = st.open('familiar'); const c = st.open(null);
  assert.deepEqual(st.snapshot().active, { familiar: 2, '(shared key)': 1 });
  a(); a(); // twice: counted once
  assert.equal(st.snapshot().active.familiar, 1);
  assert.equal(st.snapshot().peakSinceStart.familiar, 2);
  b(); c();
  assert.deepEqual(st.snapshot().active, {});
  now += 25 * 3_600_000;
  const d = st.open('familiar');
  assert.deepEqual(st.snapshot().peak24h, { familiar: 1 }, 'hours older than 24 h drop out of the rolling peak');
  assert.equal(st.snapshot().peakSinceStart.familiar, 2);
  d();
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

function connectThrough(proxyPort, target, key) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer ${key}\r\n\r\n`);
    });
    s.once('data', (d) => (String(d).startsWith('HTTP/1.1 200') ? resolve(s) : reject(new Error(String(d).split('\r\n')[0]))));
    s.on('error', reject);
  });
}

test('blind tunnels are counted per client in /teamclaude/status and released on close', async () => {
  const echo = net.createServer((s) => s.pipe(s));
  const echoPort = await listen(echo);
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'shared-k', clientKeys: [{ name: 'lane', key: 'k-lane' }] }, upstream: 'https://api.anthropic.com' });
  allowLoopbackForward(proxy);
  const port = await listen(proxy);
  const status = () => fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'shared-k' } }).then((r) => r.json());
  try {
    const socks = await Promise.all([1, 2, 3].map(() => connectThrough(port, `127.0.0.1:${echoPort}`, 'k-lane')));
    let st = await status();
    assert.equal(st.tunnels.active.lane, 3);
    assert.equal(st.tunnels.peak24h.lane, 3);
    for (const s of socks) s.destroy();
    for (let i = 0; i < 50 && (st.tunnels.active.lane || 0) > 0; i++) { await new Promise((r) => setTimeout(r, 20)); st = await status(); }
    assert.equal(st.tunnels.active.lane, undefined, 'every tunnel released');
    assert.equal(st.tunnels.peakSinceStart.lane, 3);
  } finally {
    proxy.close(); echo.close();
  }
});

test('maxTunnelsPerClient: default, 0 = none, anything else malformed is the default', async () => {
  const { maxTunnelsPerClient, DEFAULT_MAX_TUNNELS_PER_CLIENT } = await import('../src/tunnel-stats.js');
  assert.equal(maxTunnelsPerClient(undefined), DEFAULT_MAX_TUNNELS_PER_CLIENT);
  assert.equal(maxTunnelsPerClient({ maxTunnelsPerClient: 0 }), 0);
  assert.equal(maxTunnelsPerClient({ maxTunnelsPerClient: 5 }), 5);
  for (const bad of [-1, 2.5, '10', null]) assert.equal(maxTunnelsPerClient({ maxTunnelsPerClient: bad }), DEFAULT_MAX_TUNNELS_PER_CLIENT, String(bad));
});

/** CONNECT and return the status line, keeping the socket open on a 200. */
function connectRaw(proxyPort, target, key) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer ${key}\r\n\r\n`);
    });
    s.once('data', (d) => resolve({ sock: s, head: String(d) }));
    s.on('error', reject);
  });
}

test('the cap refuses one client\'s next blind tunnel with 429 + Retry-After; others and freed slots are unaffected', async () => {
  const echo = net.createServer((s) => s.pipe(s));
  const echoPort = await listen(echo);
  let dials = 0;
  echo.on('connection', () => { dials++; });
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  const config = { proxy: { apiKey: 'shared-k', clientKeys: [{ name: 'lane', key: 'k-lane' }, { name: 'other', key: 'k-other' }], maxTunnelsPerClient: 2 }, upstream: 'https://api.anthropic.com' };
  const proxy = createProxyServer(am, config);
  allowLoopbackForward(proxy);
  const port = await listen(proxy);
  const target = `127.0.0.1:${echoPort}`;
  const status = () => fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'shared-k' } }).then((r) => r.json());
  const open = [];
  try {
    for (let i = 0; i < 2; i++) { const r = await connectRaw(port, target, 'k-lane'); assert.match(r.head, /^HTTP\/1\.1 200/); open.push(r.sock); }
    const dialsBefore = dials;
    const third = await connectRaw(port, target, 'k-lane');
    assert.match(third.head, /^HTTP\/1\.1 429 Too Many Requests\r\n/);
    assert.match(third.head, /\r\nRetry-After: 1\r\n/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(dials, dialsBefore, 'a refused tunnel never dials');
    // Another client has its own budget.
    const other = await connectRaw(port, target, 'k-other');
    assert.match(other.head, /^HTTP\/1\.1 200/);
    open.push(other.sock);
    let st = await status();
    assert.equal(st.tunnels.refusedSinceStart.lane, 1);
    assert.equal(st.tunnels.refusedSinceStart.other, undefined);
    // A closed tunnel frees its slot.
    open.shift().destroy();
    for (let i = 0; i < 50 && (st.tunnels.active.lane || 0) > 1; i++) { await new Promise((r) => setTimeout(r, 20)); st = await status(); }
    const again = await connectRaw(port, target, 'k-lane');
    assert.match(again.head, /^HTTP\/1\.1 200/);
    open.push(again.sock);
    // Read per CONNECT: lifting the cap (as a reload does) admits at once; 0 = none.
    config.proxy.maxTunnelsPerClient = 0;
    for (let i = 0; i < 3; i++) { const r = await connectRaw(port, target, 'k-lane'); assert.match(r.head, /^HTTP\/1\.1 200/, `uncapped ${i}`); open.push(r.sock); }
  } finally {
    for (const s of open) s.destroy();
    proxy.close(); echo.close();
  }
});
