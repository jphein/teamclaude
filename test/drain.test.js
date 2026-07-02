import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import net from 'node:net';
import { once } from 'node:events';
import { h2Relay, h1Relay } from '../src/h2/relay.js';

// Graceful teardown of a MITM tunnel: when an account is rate-limited or a better
// one becomes available, the relay must stop feeding NEW requests to the doomed
// account and let in-flight requests DRAIN before closing — instead of the old
// behaviour of destroy()ing the sockets mid-stream (which surfaced to Claude Code
// as intermittent "API errors").

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
const T = { timeout: 30000 };

function teardown({ client, conns = [], sessions = [], servers = [] }) {
  try { client?.destroy(); } catch { /* already gone */ }
  for (const s of sessions) { try { s.destroy(); } catch { /* */ } }
  for (const c of conns) { try { c.destroy(); } catch { /* */ } }
  for (const srv of servers) { try { srv.closeAllConnections?.(); srv.close(); } catch { /* */ } }
}

async function until(pred, ms = 5000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met within ' + ms + 'ms');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ─────────────────────────── HTTP/1.1 (the Claude Code hot path) ───────────────────────────

test('h1Relay.drain() lets the in-flight response finish before closing the sockets', T, async () => {
  // Upstream: send the response head immediately, then the body after a delay,
  // so the exchange is genuinely in-flight when we drain.
  const upstream = net.createServer((s) => {
    s.on('error', () => {});
    s.once('data', () => {
      s.write('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n');
      setTimeout(() => { try { s.write('finished'); } catch { /* */ } }, 150);
    });
  });
  const upPort = await listen(upstream);

  const conns = [];
  let resolveHandle;
  const handleReady = new Promise((r) => (resolveHandle = r));
  const front = net.createServer((c) => {
    c.on('error', () => {});
    conns.push(c);
    const u = net.connect(upPort, '127.0.0.1', () => { const h = h1Relay(c, u, {}); conns.push(u); resolveHandle(h); });
    u.on('error', () => {});
  });
  const frontPort = await listen(front);

  const client = net.connect(frontPort, '127.0.0.1');
  client.on('error', () => {});
  let resp = '';
  client.setEncoding('utf8');
  client.on('data', (d) => { resp += d; });
  try {
    await once(client, 'connect');
    client.write('GET /v1/x HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n');
    const h = await handleReady;

    await until(() => resp.includes('\r\n\r\n'));    // response head relayed → in-flight
    assert.equal(h.inflight(), 1, 'the response should be in flight when we drain');

    h.drain();
    assert.equal(conns[1].destroyed, false, 'upstream socket must survive until the in-flight response completes');

    await until(() => resp.includes('finished'));
    assert.ok(resp.endsWith('finished'), 'the full response body must be relayed, not truncated');
    await until(() => conns[1].destroyed);           // and only THEN is the tunnel closed
  } finally {
    teardown({ client, conns, servers: [front, upstream] });
  }
});

test('h1Relay.drain() closes immediately when the tunnel is idle', T, async () => {
  const upstream = net.createServer((s) => s.on('error', () => {}));
  const upPort = await listen(upstream);
  const conns = [];
  let resolveHandle;
  const handleReady = new Promise((r) => (resolveHandle = r));
  const front = net.createServer((c) => {
    c.on('error', () => {});
    conns.push(c);
    const u = net.connect(upPort, '127.0.0.1', () => { const h = h1Relay(c, u, {}); conns.push(u); resolveHandle(h); });
    u.on('error', () => {});
  });
  const frontPort = await listen(front);
  const client = net.connect(frontPort, '127.0.0.1');
  client.on('error', () => {});
  try {
    await once(client, 'connect');
    const h = await handleReady;
    assert.equal(h.inflight(), 0);
    h.drain();
    await until(() => conns[1].destroyed, 3000);
    assert.equal(conns[1].destroyed, true);
  } finally {
    teardown({ client, conns, servers: [front, upstream] });
  }
});

// ─────────────────────────── HTTP/2 ───────────────────────────

test('h2Relay.drain() lets an in-flight stream finish, sends GOAWAY, then closes', T, async () => {
  const upstream = http2.createServer();
  const sessions = [];
  upstream.on('session', (s) => { sessions.push(s); s.on('error', () => {}); });
  upstream.on('stream', (s) => {
    s.on('error', () => {});
    s.respond({ ':status': 200 });
    setTimeout(() => { try { s.end('finished'); } catch { /* */ } }, 150); // delayed body → in-flight
  });
  const upPort = await listen(upstream);

  const conns = [];
  let resolveHandle;
  const handleReady = new Promise((r) => (resolveHandle = r));
  const front = net.createServer((c) => {
    c.on('error', () => {});
    const u = net.connect(upPort, '127.0.0.1', () => { const h = h2Relay(c, u, {}); conns.push(u); resolveHandle(h); });
    conns.unshift(c); // keep client socket at [0], upstream pushed at [1]
    u.on('error', () => {});
  });
  const frontPort = await listen(front);

  const client = http2.connect(`http://127.0.0.1:${frontPort}`);
  client.on('error', () => {});
  let goawayReceived = false;
  client.on('goaway', () => { goawayReceived = true; });
  try {
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages' });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; });
    req.on('error', () => {});
    req.end('{}');

    await once(req, 'response');                  // headers in; body still pending
    const h = await handleReady;
    assert.equal(h.inflight(), 1, 'one stream should be in flight when we drain');

    h.drain();
    assert.equal(conns[1].destroyed, false, 'upstream socket must not be destroyed while a stream is in flight');

    await once(req, 'close');
    assert.equal(body, 'finished', 'the in-flight response must complete instead of being aborted');
    assert.ok(goawayReceived, 'the client must receive a GOAWAY so new requests migrate to a fresh connection');
    await until(() => conns[1].destroyed);
  } finally {
    teardown({ client, conns, sessions, servers: [front, upstream] });
  }
});

test('h2Relay.drain() closes immediately when no stream is in flight', T, async () => {
  const upstream = http2.createServer();
  const sessions = [];
  upstream.on('session', (s) => { sessions.push(s); s.on('error', () => {}); });
  const upPort = await listen(upstream);
  const conns = [];
  let resolveHandle;
  const handleReady = new Promise((r) => (resolveHandle = r));
  const front = net.createServer((c) => {
    c.on('error', () => {});
    const u = net.connect(upPort, '127.0.0.1', () => { const h = h2Relay(c, u, {}); conns.push(u); resolveHandle(h); });
    conns.unshift(c);
    u.on('error', () => {});
  });
  const frontPort = await listen(front);
  const client = http2.connect(`http://127.0.0.1:${frontPort}`);
  client.on('error', () => {});
  try {
    const h = await handleReady;
    assert.equal(h.inflight(), 0);
    h.drain();
    await until(() => conns[1].destroyed, 3000);
    assert.equal(conns[1].destroyed, true);
  } finally {
    teardown({ client, conns, sessions, servers: [front, upstream] });
  }
});

test('h2Relay.drain() force-closes after the drain timeout when a stream never finishes', T, async () => {
  const upstream = http2.createServer();
  const sessions = [];
  upstream.on('session', (s) => { sessions.push(s); s.on('error', () => {}); });
  upstream.on('stream', (s) => { s.on('error', () => {}); s.respond({ ':status': 200 }); /* never ends */ });
  const upPort = await listen(upstream);
  const conns = [];
  let resolveHandle;
  const handleReady = new Promise((r) => (resolveHandle = r));
  const front = net.createServer((c) => {
    c.on('error', () => {});
    const u = net.connect(upPort, '127.0.0.1', () => { const h = h2Relay(c, u, { drainTimeoutMs: 80 }); conns.push(u); resolveHandle(h); });
    conns.unshift(c);
    u.on('error', () => {});
  });
  const frontPort = await listen(front);
  const client = http2.connect(`http://127.0.0.1:${frontPort}`);
  client.on('error', () => {});
  try {
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages' });
    req.on('data', () => {});
    req.on('error', () => {});
    req.end('{}');
    await once(req, 'response');
    const h = await handleReady;
    assert.equal(h.inflight(), 1);
    h.drain();
    assert.equal(conns[1].destroyed, false, 'must wait, not close instantly');
    await until(() => conns[1].destroyed, 3000);     // the 80ms leak-guard fires
    assert.equal(conns[1].destroyed, true);
  } finally {
    teardown({ client, conns, sessions, servers: [front, upstream] });
  }
});
