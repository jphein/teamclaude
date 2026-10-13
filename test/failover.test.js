import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { failoverPolicy, failoverEligibility, bodyForFailover, prepareForClaude, FailoverState } from '../src/failover.js';

// Local-model failover (JP, 2026-10-12): when no Claude account can serve,
// answer from the local model instead of stopping; back to Claude as soon as
// an account can serve.

const LOCAL = 'qwen36-coder';
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// ── units ────────────────────────────────────────────────────────────────
test('policy: off unless enabled with a url; defaults', () => {
  assert.equal(failoverPolicy({}).enabled, false);
  assert.equal(failoverPolicy({ failover: { enabled: true } }).enabled, false, 'no url');
  const p = failoverPolicy({ failover: { enabled: true, url: 'http://x:8091/' } });
  assert.deepEqual([p.enabled, p.url, p.model, p.afterSeconds, p.maxConcurrent, p.contextTokens], [true, 'http://x:8091', LOCAL, 20, 1, 131072]);
});

test('eligibility: every guard says why', () => {
  const policy = failoverPolicy({ failover: { enabled: true, url: 'http://x', afterSeconds: 20, maxConcurrent: 1, contextTokens: 1000 } });
  const base = { policy, state: new FailoverState(), method: 'POST', url: '/v1/messages', provider: 'anthropic', pinned: false, allQuota: false, unservableMs: 30_000, bodyBytes: 100, maxTokens: 10, contentEncoding: null };
  assert.deepEqual(failoverEligibility(base), { ok: true });
  assert.match(failoverEligibility({ ...base, unservableMs: 5000 }).why, /5s < 20s/);
  assert.deepEqual(failoverEligibility({ ...base, unservableMs: 0, allQuota: true }), { ok: true }, 'all out of quota: no wait');
  assert.match(failoverEligibility({ ...base, url: '/v1/messages/count_tokens' }).why, /not a messages request/);
  assert.match(failoverEligibility({ ...base, bodyBytes: 10_000 }).why, /exceeds the local window/);
  assert.match(failoverEligibility({ ...base, contentEncoding: 'gzip' }).why, /compressed/);
  const busy = new FailoverState(); busy.inFlight = 1;
  assert.match(failoverEligibility({ ...base, state: busy }).why, /busy/);
});

test('bodyForFailover: local model name, thinking off, unsigned thinking stripped, the rest intact', () => {
  const body = Buffer.from(JSON.stringify({
    model: 'claude-opus-5-5', max_tokens: 50, stream: true, thinking: { type: 'enabled', budget_tokens: 1000 },
    tools: [{ name: 't', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: '' }, { type: 'text', text: 'yo' }] }],
  }));
  const out = JSON.parse(bodyForFailover(body, LOCAL).toString());
  assert.equal(out.model, LOCAL);
  assert.equal(out.thinking, undefined);
  assert.deepEqual(out.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(out.messages[1].content, [{ type: 'text', text: 'yo' }]);
  assert.equal(out.tools.length, 1);
  assert.equal(out.stream, true);
});

test('prepareForClaude: removes unsigned thinking; turns thinking off when the last assistant tool_use has none; leaves real Claude turns alone', () => {
  const localTurn = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] };
  const back = Buffer.from(JSON.stringify({
    model: 'claude-opus-5-5', thinking: { type: 'enabled', budget_tokens: 1000 },
    messages: [{ role: 'user', content: 'go' }, localTurn, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }],
  }));
  const r = prepareForClaude(back);
  assert.equal(r.droppedThinking, true);
  assert.equal(JSON.parse(r.body.toString()).thinking, undefined);
  const signed = Buffer.from(JSON.stringify({
    model: 'claude-opus-5-5', thinking: { type: 'enabled', budget_tokens: 1000 },
    messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }],
  }));
  const same = prepareForClaude(signed);
  assert.equal(same.changed, false);
  assert.equal(same.body, signed, 'byte-for-byte');
  const unsigned = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: '' }, { type: 'text', text: 'a' }] }] }));
  assert.deepEqual(JSON.parse(prepareForClaude(unsigned).body.toString()).messages[0].content, [{ type: 'text', text: 'a' }]);
});

// ── through the real proxy ───────────────────────────────────────────────
async function setup({ failover = {}, exhausted = true, localStatus = 200, claudeHits = [] } = {}) {
  const localSeen = [];
  const local = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      localSeen.push({ body: JSON.parse(raw), auth: req.headers['x-api-key'] ?? null });
      if (localStatus !== 200) { res.writeHead(localStatus, { 'content-type': 'application/json' }); res.end('{"error":{"message":"context too long"}}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'l1', type: 'message', role: 'assistant', model: LOCAL, content: [{ type: 'text', text: 'local says hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const claude = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      claudeHits.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'c1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'claude' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const [lp, cp] = [await listen(local), await listen(claude)];
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  if (exhausted) { am.accounts[0].quota.unified5h = 1; am.accounts[0].quota.unified5hReset = Date.now() + 3 * 3600_000; am.accounts[0].probing = false; }
  // The exhausted-fleet probe would forward one request to Claude anyway; a
  // probe already spent this hour is the state a real stall is in.
  am._nextProbeAt = Date.now() + 3600_000;
  const config = { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${cp}`, failover: { enabled: true, url: `http://127.0.0.1:${lp}`, afterSeconds: 20, ...failover } };
  const logs = []; const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  const proxy = createProxyServer(am, config, {});
  const port = await listen(proxy);
  return {
    am, localSeen, claudeHits, logs,
    post: (body) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify(body) }),
    status: () => fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'k' } }).then((r) => r.json()),
    close() { console.log = orig; proxy.close(); local.close(); claude.close(); },
  };
}
const MSG = { model: 'claude-opus-5-5', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] };

test('every account out of quota: served by the local model at once, tagged and counted', async () => {
  const t = await setup({ failover: { apiKey: 'lk' } });
  try {
    const res = await t.post(MSG);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-teamclaude-failover'), `local/${LOCAL}`);
    assert.equal(body.model, LOCAL, 'agents can see they are on the local model');
    assert.equal(t.localSeen[0].body.model, LOCAL);
    assert.equal(t.localSeen[0].auth, 'lk');
    assert.ok(t.logs.some((l) => /FAILOVER: no Claude account can serve — served by local model "qwen36-coder"/.test(l)), t.logs.join('\n'));
    const st = (await t.status()).failover;
    assert.equal(st.served, 1);
    assert.equal(st.active, true);
  } finally { t.close(); }
});

test('off by default: the usual 429, nothing sent to the local model', async () => {
  const t = await setup({ failover: { enabled: false } });
  try {
    const res = await t.post(MSG);
    await res.text();
    assert.equal(res.status, 429);
    assert.equal(t.localSeen.length, 0);
  } finally { t.close(); }
});

test('hysteresis: a fleet that is only rate-limited waits afterSeconds before failing over', async () => {
  const t = await setup({ exhausted: false });
  try {
    t.am.markRateLimited(0, 3600);
    const res = await t.post(MSG);
    await res.text();
    assert.equal(res.status, 429, 'not yet: one burst does not switch models');
    assert.equal(t.localSeen.length, 0);
  } finally { t.close(); }
  const u = await setup({ exhausted: false, failover: { afterSeconds: 0 } });
  try {
    u.am.markRateLimited(0, 3600);
    const res = await u.post(MSG);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(u.localSeen.length, 1);
  } finally { u.close(); }
});

test('a local error becomes the usual 429, never the local model\'s error text', async () => {
  const t = await setup({ localStatus: 400 });
  try {
    const res = await t.post(MSG);
    const body = await res.json();
    assert.equal(res.status, 429);
    assert.equal(body.error.type, 'rate_limit_error');
  } finally { t.close(); }
});

test('a request too large for the local window is not sent there', async () => {
  const t = await setup({ failover: { contextTokens: 1024 } });
  try {
    const res = await t.post({ ...MSG, messages: [{ role: 'user', content: 'x'.repeat(10_000) }] });
    await res.text();
    assert.equal(res.status, 429);
    assert.equal(t.localSeen.length, 0);
  } finally { t.close(); }
});

test('fail-back: the first request after an account frees up goes to Claude, repaired', async () => {
  const claudeHits = [];
  const t = await setup({ claudeHits });
  try {
    await (await t.post(MSG)).text();
    assert.equal(t.localSeen.length, 1, 'served locally while exhausted');
    // The account renews.
    t.am.accounts[0].quota.unified5h = 0.1;
    const back = { ...MSG, thinking: { type: 'enabled', budget_tokens: 1024 }, max_tokens: 2048,
      messages: [{ role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'local', signature: '' }, { type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }] };
    const res = await t.post(back);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.model, 'claude-opus-5-5', 'back on Claude');
    assert.equal(t.localSeen.length, 1, 'not sent locally again');
    const sent = claudeHits.at(-1);
    assert.equal(sent.thinking, undefined, 'thinking off for this one turn');
    assert.ok(!JSON.stringify(sent.messages).includes('"signature":""'), 'unsigned thinking removed');
    assert.equal((await t.status()).failover.active, false);
  } finally { t.close(); }
});
