// Restart drain (src/drain.js): a stream open at SIGTERM reaches its client whole; a new request is
// turned away with a retryable 503; the deadline closes what outlives it. 2026-11-16: restarts cut
// live streams (Squire 08:35) because shutdown closed every connection at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { drain, drainMsFrom, DEFAULT_DRAIN_SECONDS } from '../src/drain.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
async function until(condition) {
  while (!condition()) await new Promise(r => setImmediate(r));
}

/** A proxy in front of an upstream that holds each stream open until release(). */
async function rig() {
  let release;
  const gate = new Promise(r => { release = r; });
  let firstChunk;
  const started = new Promise(r => { firstChunk = r; });
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {"type":"ping"}\n\n');
      firstChunk();
      await gate;
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'k1' }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upPort}` }, {});
  const port = await listen(proxy);
  const send = () => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5', messages: [], stream: true }),
  });
  return { am, proxy, upstream, send, started, release: () => release(), close: () => { proxy.close(); upstream.close(); } };
}

test('a stream open at shutdown reaches its client whole; drain waits for it, then exits', async () => {
  const r = await rig();
  try {
    const pending = r.send().then(res => res.text());
    await r.started;
    await until(() => r.am.openStreams() === 1);
    const logs = [];
    let closedAll = false;
    const done = drain({ am: r.am, drainMs: 10_000, pollMs: 5, log: (l) => logs.push(l),
      closeListeners: () => { r.proxy.close(); }, closeAll: () => { closedAll = true; r.proxy.closeAllConnections?.(); } });
    // the stream is still open, so the drain is still waiting
    await new Promise(res => setTimeout(res, 50));
    assert.equal(closedAll, false, 'nothing closed while a stream is open');
    r.release();
    const body = await pending;
    assert.match(body, /message_stop/, 'the client got the whole stream');
    const out = await done;
    assert.equal(out.drained, true);
    assert.equal(closedAll, true);
    assert.ok(logs.some(l => /Draining: 1 open stream/.test(l)));
    assert.ok(logs.some(l => /Drained in/.test(l)));
  } finally { r.close(); }
});

test('while draining, a new request is turned away with a retryable 503 and never reaches upstream', async () => {
  const r = await rig();
  try {
    r.am.draining = true;
    const res = await r.send();
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '2');
    assert.equal((await res.json()).error.type, 'overloaded_error');
    assert.equal(r.am.accounts[0].usage.totalRequests, 0, 'never dispatched');
  } finally { r.close(); }
});

test('the deadline closes a stream that outlives it', async () => {
  let t = 0;
  const am = { openStreams: () => 1, draining: false };
  let closedAll = false;
  const out = await drain({ am, drainMs: 1000, pollMs: 250, now: () => t, sleep: async (ms) => { t += ms; },
    closeListeners: () => {}, closeAll: () => { closedAll = true; }, log: () => {} });
  assert.equal(out.drained, false);
  assert.equal(out.open, 1);
  assert.equal(out.waitedMs, 1000);
  assert.equal(closedAll, true);
  assert.equal(am.draining, true);
});

test('nothing open: closes at once without waiting', async () => {
  let slept = 0;
  const out = await drain({ am: { openStreams: () => 0 }, drainMs: 5000, sleep: async () => { slept++; },
    closeListeners: () => {}, closeAll: () => {}, log: () => {} });
  assert.equal(out.drained, true);
  assert.equal(slept, 0);
});

test('drainSeconds: a non-negative number from config, else the default (below OpenRC TERM/10)', () => {
  assert.equal(DEFAULT_DRAIN_SECONDS, 8);
  assert.equal(drainMsFrom({}), 8000);
  assert.equal(drainMsFrom({ drainSeconds: 90 }), 90_000);
  assert.equal(drainMsFrom({ drainSeconds: 0 }), 0);
  for (const bad of [-1, 'x', null, Infinity]) assert.equal(drainMsFrom({ drainSeconds: bad }), 8000, String(bad));
});

test('status reports openStreams per account (the restart gate counts it)', () => {
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'k1' }], 0.98);
  am.beginActivity(0);
  assert.equal(am.openStreams(), 1);
  const st = /** @type {any} */ (am.getStatus());
  const row = Array.isArray(st) ? st[0] : st.accounts[0];
  assert.equal(row.openStreams, 1);
  am.endActivity(0);
  assert.equal(am.openStreams(), 0);
});
