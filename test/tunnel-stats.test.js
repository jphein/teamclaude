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
