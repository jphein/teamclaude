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

// The MITM test below mints a leaf: certificates go to a throwaway config dir.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
process.env.TEAMCLAUDE_CONFIG = join(mkdtempSync(join(tmpdir(), 'tc-tunnelcap-home-')), 'teamclaude.json');
test.after(() => rmSync(dirname(/** @type {string} */ (process.env.TEAMCLAUDE_CONFIG)), { recursive: true, force: true }));

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

/** A capped proxy for the lifecycle tests. */
async function cappedProxy(cap) {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  const config = { proxy: { apiKey: 'shared-k', clientKeys: [{ name: 'lane', key: 'k-lane' }], maxTunnelsPerClient: cap }, upstream: 'https://api.anthropic.com' };
  const proxy = createProxyServer(am, config);
  allowLoopbackForward(proxy);
  const port = await listen(proxy);
  const status = () => fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'shared-k' } }).then((r) => r.json());
  const settled = async () => {
    let st = await status();
    for (let i = 0; i < 100 && (st.tunnels.active.lane || 0) > 0; i++) { await new Promise((r) => setTimeout(r, 20)); st = await status(); }
    return st;
  };
  return { proxy, port, status, settled };
}

test('every failed or abandoned tunnel releases its slot: dial refused, client gone mid-dial, upstream closing', async () => {
  const { proxy, port, settled } = await cappedProxy(2);
  const dead = net.createServer(); const deadPort = await listen(dead); dead.close();
  const slam = net.createServer((s) => s.destroy()); const slamPort = await listen(slam);
  const echo = net.createServer((s) => s.pipe(s)); const echoPort = await listen(echo);
  try {
    // Dial refused: a 502 each time, never a 429 — the slots come back.
    for (let i = 0; i < 5; i++) {
      const r = await connectRaw(port, `127.0.0.1:${deadPort}`, 'k-lane');
      assert.match(r.head, /^HTTP\/1\.1 502/, `refused dial ${i}`);
      r.sock.destroy();
    }
    // The client leaves right after asking.
    await Promise.all([1, 2, 3, 4, 5].map(() => new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => { s.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nProxy-Authorization: Bearer k-lane\r\n\r\n`); s.destroy(); resolve(); });
      s.on('error', resolve);
    })));
    // The upstream accepts and hangs up at once.
    for (let i = 0; i < 4; i++) {
      const r = await connectRaw(port, `127.0.0.1:${slamPort}`, 'k-lane');
      r.sock.destroy();
    }
    const st = await settled();
    // (Five at once against a cap of 2: some of the abandoned ones were refused
    // while others were still counted — correct, and also released.)
    assert.equal(st.tunnels.active.lane, undefined, 'nothing left counted');
    // And the full budget is there again.
    const a = await connectRaw(port, `127.0.0.1:${echoPort}`, 'k-lane');
    const b = await connectRaw(port, `127.0.0.1:${echoPort}`, 'k-lane');
    assert.match(a.head + b.head, /^HTTP\/1\.1 200[\s\S]*HTTP\/1\.1 200/);
    a.sock.destroy(); b.sock.destroy();
  } finally { proxy.close(); slam.close(); echo.close(); }
});

test('intercepted Claude traffic takes no slot: at the cap, a CONNECT to the upstream host still opens', async () => {
  const { proxy, port, status } = await cappedProxy(1);
  const echo = net.createServer((s) => s.pipe(s)); const echoPort = await listen(echo);
  try {
    const blind = await connectRaw(port, `127.0.0.1:${echoPort}`, 'k-lane');
    assert.match(blind.head, /^HTTP\/1\.1 200/);
    assert.match((await connectRaw(port, `127.0.0.1:${echoPort}`, 'k-lane')).head, /^HTTP\/1\.1 429/, 'positive control: the cap is reached');
    const claude = await connectRaw(port, 'api.anthropic.com:443', 'k-lane');
    assert.match(claude.head, /^HTTP\/1\.1 200/, 'MITM is not a blind tunnel');
    const st = await status();
    assert.equal(st.tunnels.active.lane, 1);
    assert.equal(st.tunnels.refusedSinceStart.lane, 1, 'only the blind one was refused');
    blind.sock.destroy(); claude.sock.destroy();
  } finally { proxy.close(); echo.close(); }
});

test('a handler built without shared stats still enforces the cap', async () => {
  const { createConnectHandler } = await import('../src/mitm.js');
  const handler = createConnectHandler({ config: { proxy: { maxTunnelsPerClient: 1 } }, accountManager: { accounts: [] }, ensureLeaf: async () => null });
  const echo = net.createServer((s) => s.pipe(s)); const echoPort = await listen(echo);
  const srv = (await import('node:http')).createServer();
  srv.on('connect', handler);
  allowLoopbackForward(srv);
  const port = await listen(srv);
  try {
    const first = await connectRaw(port, `127.0.0.1:${echoPort}`, 'any');
    assert.match(first.head, /^HTTP\/1\.1 200/);
    assert.match((await connectRaw(port, `127.0.0.1:${echoPort}`, 'any')).head, /^HTTP\/1\.1 429/);
    first.sock.destroy();
  } finally { srv.close(); echo.close(); }
});

test('a client that gives up on a slow dial frees its slot at once, not after the 30 s timeout', async () => {
  const { proxy, port, status } = await cappedProxy(5);
  try {
    // A blackholed address: the dial hangs (where the network instead refuses
    // at once, the slot comes back by that path, and the test still holds).
    const s = net.connect(port, '127.0.0.1');
    await new Promise((r) => s.on('connect', r));
    s.write('CONNECT 10.255.255.1:443 HTTP/1.1\r\nProxy-Authorization: Bearer k-lane\r\n\r\n');
    await new Promise((r) => setTimeout(r, 150));
    s.end();
    let st = await status();
    for (let i = 0; i < 25 && (st.tunnels.active.lane || 0) > 0; i++) { await new Promise((r) => setTimeout(r, 40)); st = await status(); }
    assert.equal(st.tunnels.active.lane, undefined, 'released within a second of the client leaving');
  } finally { proxy.close(); }
});

// Bytes in the CONNECT's own packet arrive as `head`; the early buffer covers a
// later packet during a slow dial, which a loopback dial is too fast to show.
test('bytes a client pipelines before the 200 reach the tunnel', async () => {
  const { proxy, port } = await cappedProxy(5);
  const echo = net.createServer((c) => c.pipe(c)); const echoPort = await listen(echo);
  try {
    const got = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nProxy-Authorization: Bearer k-lane\r\n\r\nhello-early`));
      let buf = '';
      s.on('data', (d) => { buf += d; if (buf.includes('hello-early')) { s.destroy(); resolve(buf); } });
      s.on('error', reject);
      setTimeout(() => { s.destroy(); resolve(buf); }, 3000);
    });
    assert.match(got, /^HTTP\/1\.1 200[\s\S]*hello-early/);
  } finally { proxy.close(); echo.close(); }
});

test('Anthropic and Claude hosts get bounded headroom past the cap', async () => {
  const { createConnectHandler } = await import('../src/mitm.js');
  const am = { accounts: [] };
  const config = { proxy: { maxTunnelsPerClient: 1 }, upstream: 'https://api.anthropic.com' };
  const { TunnelStats: TS } = await import('../src/tunnel-stats.js');
  const stats = new TS();
  const handler = createConnectHandler({ config, accountManager: am, ensureLeaf: async () => null, tunnelStats: stats });
  const srv = (await import('node:http')).createServer();
  srv.on('connect', handler);
  allowLoopbackForward(srv);
  const port = await listen(srv);
  const echo = net.createServer((c) => c.pipe(c)); const echoPort = await listen(echo);
  try {
    const first = await connectRaw(port, `127.0.0.1:${echoPort}`, 'k');
    assert.match(first.head, /^HTTP\/1\.1 200/);
    // At the cap: an ordinary host is refused, a Claude host is not (whatever its dial does after).
    assert.match((await connectRaw(port, `127.0.0.1:${echoPort}`, 'k')).head, /^HTTP\/1\.1 429/);
    for (const h of ['platform.claude.com:443', 'claude.ai:443', 'console.anthropic.com:443']) {
      const r = await connectRaw(port, h, 'k');
      assert.doesNotMatch(r.head, /^HTTP\/1\.1 429/, h);
      r.sock.destroy();
    }
    for (const h of ['evil-anthropic.com:443', 'anthropic.com.evil:443', 'xclaude.ai:443', 'claude.com.attacker.example:443']) {
      assert.match((await connectRaw(port, h, 'k')).head, /^HTTP\/1\.1 429/, `lookalike ${h} gets no headroom`);
    }
    // Bounded: with the bucket filled past cap + headroom, a Claude host is refused too.
    const fill = [];
    for (let i = 0; i < 40; i++) fill.push(stats.open(null)); // no keys configured: the caller is '(shared key)'
    assert.match((await connectRaw(port, 'platform.claude.com:443', 'k')).head, /^HTTP\/1\.1 429/, 'the headroom is finite');
    for (const close of fill) close();
    first.sock.destroy();
  } finally { srv.close(); echo.close(); }
});

/** A connect handler whose blind-tunnel dials wait `ms` in DNS first: a genuinely pending dial. */
async function slowDialProxy(ms, cap = 5) {
  const { createConnectHandler } = await import('../src/mitm.js');
  const { TunnelStats: TS } = await import('../src/tunnel-stats.js');
  const dns = await import('node:dns');
  const stats = new TS();
  const dialLookup = (host, opts, cb) => setTimeout(() => dns.lookup(host, opts, cb), ms);
  const handler = createConnectHandler({ config: { proxy: { maxTunnelsPerClient: cap } }, accountManager: { accounts: [] }, ensureLeaf: async () => null, tunnelStats: stats, dialLookup });
  const srv = (await import('node:http')).createServer();
  srv.on('connect', handler);
  allowLoopbackForward(srv);
  const port = await listen(srv);
  return { srv, port, stats };
}

test('a pending dial: head, early chunks and post-200 bytes arrive once and in order', async () => {
  const { srv, port } = await slowDialProxy(300);
  const echo = net.createServer((c) => c.pipe(c)); const echoPort = await listen(echo);
  try {
    const got = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', async () => {
        s.write(`CONNECT localhost:${echoPort} HTTP/1.1\r\n\r\nH1`);
        await new Promise((r) => setTimeout(r, 60)); s.write('E2');
        await new Promise((r) => setTimeout(r, 60)); s.write('E3');
      });
      let buf = '';
      s.on('data', (d) => {
        buf += d;
        if (buf.includes('\r\n\r\n') && !buf.includes('P4') && !s.sentPost) { s.sentPost = true; s.write('P4'); }
        if (buf.endsWith('P4')) { s.destroy(); resolve(buf); }
      });
      s.on('error', reject);
      setTimeout(() => { s.destroy(); resolve(buf); }, 3000);
    });
    assert.match(got, /^HTTP\/1\.1 200[^]*\r\n\r\nH1E2E3P4$/, JSON.stringify(got));
  } finally { srv.close(); echo.close(); }
});

test('a pending dial: the client leaving frees the slot at once, and a FIN before the 200 is giving up', async () => {
  const { srv, port, stats } = await slowDialProxy(800);
  const echo = net.createServer((c) => c.pipe(c)); const echoPort = await listen(echo);
  try {
    for (const leave of ['destroy', 'end']) {
      const s = net.connect(port, '127.0.0.1');
      await new Promise((r) => s.on('connect', r));
      s.write(`CONNECT localhost:${echoPort} HTTP/1.1\r\n\r\n`);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(stats.active(null), 1, `${leave}: counted while dialling`);
      s[leave]();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(stats.active(null), 0, `${leave}: released well before the dial resolves`);
      s.destroy();
    }
  } finally { srv.close(); echo.close(); }
});

test('a pending dial: more than 64 KiB before the 200 is refused (the CONNECT\'s own trailing bytes count)', async () => {
  const { srv, port, stats } = await slowDialProxy(300);
  const echo = net.createServer((c) => c.pipe(c)); const echoPort = await listen(echo);
  try {
    for (const split of [false, true]) {
      const head = await new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', async () => {
          const big = 'x'.repeat(70_000);
          if (split) { s.write(`CONNECT localhost:${echoPort} HTTP/1.1\r\n\r\n`); await new Promise((r) => setTimeout(r, 30)); s.write(big); }
          else s.write(`CONNECT localhost:${echoPort} HTTP/1.1\r\n\r\n${big}`);
        });
        let buf = ''; s.on('data', (d) => { buf += d; }); s.on('close', () => resolve(buf)); s.on('error', () => resolve(buf));
        setTimeout(() => { s.destroy(); reject(new Error('no answer')); }, 3000);
      });
      assert.match(head, /^HTTP\/1\.1 413/, split ? 'in later chunks' : 'with the CONNECT');
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(stats.active(null), 0);
  } finally { srv.close(); echo.close(); }
});
