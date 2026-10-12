import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  isFableModel, fablePolicy, decideFable, rewriteFableBody, clientAllowed, FableStats,
  SHARED_KEY_ENTRY, DEFAULT_FABLE_MODEL,
} from '../src/fable-policy.js';

// Fable rationing (JP, 2026-10-11 19:5x): "you and my claudes should use
// fable". Only clients named in fable.allow may use Fable; every other Fable
// request is served as Opus — rewritten, never refused, so no lane breaks.
// An allowed client falls back to Opus when no account has Fable left, or when
// upstream answers Fable with 529 ("and ii for sure").

const FABLE = 'claude-fable-5-1';
const OPUS = 'claude-opus-5-5';
const ALLOW = ['jp-wakizashi', 'jp-92'];

// ── policy ───────────────────────────────────────────────────────────────
test('isFableModel matches any Fable id, nothing else', () => {
  for (const m of ['claude-fable-5', 'claude-fable-5-1', 'Claude-FABLE-x']) assert.ok(isFableModel(m), m);
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', '', null, undefined, 42]) assert.ok(!isFableModel(m), String(m));
});

test('policy: no fable block = rationing off; empty allow = nobody; a Fable fallback model is refused', () => {
  assert.equal(fablePolicy({}).enabled, false);
  const empty = fablePolicy({ fable: { allow: [] } });
  assert.equal(empty.enabled, true);
  assert.equal(empty.allow.size, 0);
  assert.equal(empty.model, DEFAULT_FABLE_MODEL);
  assert.equal(fablePolicy({ fable: { allow: [], model: 'claude-fable-5' } }).model, DEFAULT_FABLE_MODEL);
  assert.equal(fablePolicy({ fable: { allow: [' jp-92 '], model: ' claude-opus-5-1 ' } }).model, 'claude-opus-5-1');
  assert.ok(fablePolicy({ fable: { allow: [' jp-92 '] } }).allow.has('jp-92'));
});

test('clientAllowed: by key name only; the shared key needs its explicit entry', () => {
  const p = fablePolicy({ fable: { allow: ALLOW } });
  assert.ok(clientAllowed(p, 'jp-92'));
  assert.ok(!clientAllowed(p, 'familiar'));
  assert.ok(!clientAllowed(p, null), 'shared key / key-less is not allowed by default');
  assert.ok(clientAllowed(fablePolicy({ fable: { allow: [SHARED_KEY_ENTRY] } }), null));
});

test('decideFable: the full matrix', () => {
  const p = fablePolicy({ fable: { allow: ALLOW } });
  const yes = () => true; const no = () => false;
  assert.deepEqual(decideFable({ policy: p, model: OPUS, client: 'familiar', fableAvailable: no }), { action: 'pass' });
  assert.deepEqual(decideFable({ policy: p, model: FABLE, client: 'familiar', fableAvailable: yes }), { action: 'rewrite', to: OPUS });
  assert.deepEqual(decideFable({ policy: p, model: FABLE, client: null, fableAvailable: yes }), { action: 'rewrite', to: OPUS });
  assert.deepEqual(decideFable({ policy: p, model: FABLE, client: 'jp-92', fableAvailable: yes }), { action: 'pass' });
  assert.deepEqual(decideFable({ policy: p, model: FABLE, client: 'jp-92', fableAvailable: no }), { action: 'fallback', to: OPUS });
  assert.deepEqual(decideFable({ policy: p, model: OPUS, advisorModel: FABLE, client: 'familiar', fableAvailable: yes }), { action: 'rewrite', to: OPUS }, 'a Fable advisor is rationed too');
  assert.deepEqual(decideFable({ policy: fablePolicy({}), model: FABLE, client: 'familiar', fableAvailable: no }), { action: 'pass' }, 'rationing off');
});

test('rewriteFableBody: top-level and advisor models; other fields and non-JSON untouched', () => {
  const body = Buffer.from(JSON.stringify({ model: FABLE, max_tokens: 5, tools: [{ type: 'advisor_20260301', model: FABLE }, { name: 'x' }] }));
  const out = rewriteFableBody(body, OPUS);
  assert.equal(out.changed, true);
  const obj = JSON.parse(out.body.toString());
  assert.equal(obj.model, OPUS);
  assert.equal(obj.tools[0].model, OPUS);
  assert.deepEqual(obj.tools[1], { name: 'x' });
  assert.equal(obj.max_tokens, 5);
  const plain = Buffer.from('not json');
  assert.equal(rewriteFableBody(plain, OPUS).body, plain);
  const opus = Buffer.from(JSON.stringify({ model: OPUS }));
  assert.equal(rewriteFableBody(opus, OPUS).changed, false);
});

test('FableStats: counts today, remembers the last fallback, resets at the local day change', () => {
  let now = new Date(2026, 9, 11, 23, 59, 0);
  const st = new FableStats(() => now);
  st.record('rewrite', { client: 'familiar', from: FABLE, to: OPUS, reason: 'x' });
  st.record('rewrite', { client: 'familiar', from: FABLE, to: OPUS, reason: 'x' });
  st.record('fallback', { client: 'jp-92', from: FABLE, to: OPUS, reason: 'no account has Fable allowance left' });
  const a = st.snapshot();
  assert.equal(a.rewritten, 2);
  assert.equal(a.fallbacks, 1);
  assert.equal(a.lastFallback.client, 'jp-92');
  now = new Date(2026, 9, 12, 0, 0, 1);
  assert.deepEqual(st.snapshot(), { day: '2026-10-12', rewritten: 0, fallbacks: 0, lastFallback: null });
});

// ── through the real proxy ───────────────────────────────────────────────
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

async function setup({ fable = { allow: ALLOW }, fableSpent = false, fable529 = false, all529 = false, blockedModels, modelMap } = {}) {
  const seen = [];
  const raws = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); });
    req.on('end', () => {
      // Decoded like a real upstream would, so the stub sees what it would serve.
      const bytes = Buffer.concat(chunks);
      const raw = (req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(bytes) : bytes).toString('utf8');
      let m = null; let adv = null; try { const o = JSON.parse(raw); m = o.model; adv = o.tools?.[0]?.model ?? null; } catch { /* */ }
      seen.push(m);
      raws.push({ raw, encoding: req.headers['content-encoding'] ?? null, length: req.headers['content-length'], bytes: bytes.length });
      if (all529 || (fable529 && (isFableModel(m) || isFableModel(adv)))) {
        res.writeHead(529, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: m, content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...(modelMap ? { modelMap } : {}) },
    { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  if (fableSpent) {
    for (const acct of am.accounts) { acct.quota.unified7dFable = 1; acct.quota.unified7dFableReset = Date.now() + 90 * 3600_000; acct.probing = false; }
  }
  const config = {
    proxy: { apiKey: 'shared-k', clientKeys: [{ name: 'familiar', key: 'k-fam' }, { name: 'jp-92', key: 'k-92' }, { name: 'jp-wakizashi', key: 'k-wz' }] },
    upstream: `http://127.0.0.1:${upPort}`,
    ...(blockedModels ? { blockedModels } : {}),
    ...(fable === null ? {} : { fable }),   // null = no fable block (rationing off)
  };
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  const proxy = createProxyServer(am, config, {});
  const port = await listen(proxy);
  return {
    seen, logs, raws,
    postRaw: (key, buf, headers = {}) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, ...headers }, body: buf }),
    post: (key, model, extra = {}) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }], ...extra }),
    }),
    status: () => fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'shared-k' } }).then((r) => r.json()),
    close() { console.log = orig; proxy.close(); upstream.close(); },
  };
}

test('a lane (familiar key) asking for Fable is served as Opus — never refused — and logged', async () => {
  const t = await setup();
  try {
    const res = await t.post('k-fam', FABLE);
    await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(t.seen, [OPUS], 'upstream received Opus');
    assert.ok(t.logs.some((l) => /Fable rewritten: claude-fable-5-1 → claude-opus-5-5 for "familiar" — not on fable\.allow/.test(l)), t.logs.join('\n'));
    const st = await t.status();
    assert.equal(st.fable.rewritten, 1);
    assert.deepEqual(st.fable.allow, ALLOW);
  } finally { t.close(); }
});

test('an allowed client (jp-92) keeps Fable while an account can serve it', async () => {
  const t = await setup();
  try {
    const res = await t.post('k-92', FABLE);
    await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(t.seen, [FABLE]);
    assert.ok(!t.logs.some((l) => /Fable (rewritten|fallback)/.test(l)));
  } finally { t.close(); }
});

test('the shared key is not allowed unless "(shared key)" is listed', async () => {
  const t = await setup();
  try {
    await (await t.post('shared-k', FABLE)).text();
    assert.deepEqual(t.seen, [OPUS]);
  } finally { t.close(); }
  const u = await setup({ fable: { allow: [SHARED_KEY_ENTRY] } });
  try {
    await (await u.post('shared-k', FABLE)).text();
    assert.deepEqual(u.seen, [FABLE]);
  } finally { u.close(); }
});

test('fallback (ii): an allowed client gets Opus when every account\'s Fable allowance is spent — not a 429', async () => {
  const t = await setup({ fableSpent: true });
  try {
    const res = await t.post('k-wz', FABLE);
    await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(t.seen, [OPUS]);
    assert.ok(t.logs.some((l) => /Fable fallback: .* for "jp-wakizashi" — no account has Fable allowance left/.test(l)), t.logs.join('\n'));
    const st = await t.status();
    assert.equal(st.fable.fallbacks, 1);
    assert.equal(st.fable.lastFallback.client, 'jp-wakizashi');
  } finally { t.close(); }
});

// What an allowed client got before this feature when no account had Fable
// left (measured here, rationing off): an immediate local 429, nothing sent
// upstream, no waiting (holdSeconds 0).
test('without rationing, spent Fable is an immediate local 429 (the old behaviour, for the record)', async () => {
  const t = await setup({ fable: null, fableSpent: true });
  try {
    for (let i = 0; i < 2; i++) {
      const res = await t.post('k-wz', FABLE);
      await res.text();
      assert.equal(res.status, 429);
    }
    assert.deepEqual(t.seen, [], 'nothing reached upstream');
  } finally { t.close(); }
});

test('fallback (ii): Fable at capacity (529) for an allowed client is retried once as Opus', async () => {
  const t = await setup({ fable529: true });
  try {
    const res = await t.post('k-92', FABLE);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.model, OPUS);
    assert.deepEqual(t.seen, [FABLE, OPUS], 'one Fable attempt, then Opus');
    assert.ok(t.logs.some((l) => /Fable fallback: .* for "jp-92" — upstream 529/.test(l)), t.logs.join('\n'));
  } finally { t.close(); }
});

test('a non-Fable 529 is not turned into a model change', async () => {
  const t = await setup({ all529: true });
  try {
    const res = await t.post('k-92', OPUS);
    await res.text();
    assert.equal(res.status, 529, 'the overload reaches the client as before');
    assert.ok(t.seen.length >= 1 && t.seen.every((m) => m === OPUS), JSON.stringify(t.seen));
    assert.ok(!t.logs.some((l) => /Fable fallback/.test(l)));
  } finally { t.close(); }
});

// ── hardening (security scan + cross-model review of PR #23) ──────────────
const noFableUpstream = (t) => assert.ok(t.raws.every((r) => !/fable/i.test(r.raw)), 'upstream saw a Fable model: ' + t.raws.map((r) => r.raw).join(' | '));

test('duplicate "model" keys cannot smuggle Fable past the check, in either order', async () => {
  const t = await setup();
  try {
    for (const raw of [`{"model":"${OPUS}","model":"${FABLE}","messages":[]}`, `{"model":"${FABLE}","model":"${OPUS}","messages":[]}`]) {
      const res = await t.postRaw('k-fam', raw);
      await res.text();
      assert.equal(res.status, 200, raw);
    }
    noFableUpstream(t);
  } finally { t.close(); }
});

test('an escaped Fable id and a batch item\'s nested model are rewritten too', async () => {
  const t = await setup();
  try {
    await (await t.postRaw('k-fam', `{"model":"claude-fabl\\u0065-5","messages":[]}`)).text();
    await (await t.postRaw('k-fam', JSON.stringify({ requests: [{ custom_id: 'x', params: { model: FABLE, messages: [] } }] }))).text();
    noFableUpstream(t);
    assert.equal(JSON.parse(t.raws[1].raw).requests[0].params.model, OPUS);
  } finally { t.close(); }
});

test('a gzip body from a lane is decoded, rewritten and sent uncompressed with a correct length', async () => {
  const t = await setup();
  try {
    const res = await t.postRaw('k-fam', zlib.gzipSync(JSON.stringify({ model: FABLE, messages: [] })), { 'content-encoding': 'gzip' });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.raws[0].encoding, null, 'Content-Encoding removed');
    assert.equal(JSON.parse(t.raws[0].raw).model, OPUS);
    assert.equal(Number(t.raws[0].length), t.raws[0].bytes);
  } finally { t.close(); }
});

test('an encoding the policy cannot read is refused for a lane (415), never forwarded', async () => {
  const t = await setup();
  try {
    const res = await t.postRaw('k-fam', Buffer.from('opaque'), { 'content-encoding': 'compress' });
    await res.text();
    assert.equal(res.status, 415);
    assert.equal(t.raws.length, 0);
  } finally { t.close(); }
});

test('an account modelMap that maps TO Fable is caught by the final gate', async () => {
  const t = await setup({ modelMap: { 'sneaky-alias': FABLE } });
  try {
    await (await t.post('k-fam', 'sneaky-alias')).text();
    noFableUpstream(t);
    assert.deepEqual(t.seen, [OPUS]);
  } finally { t.close(); }
});

test('rationing runs before the blocklist: a lane\'s blocked Fable is served as Opus; an allowed client is still blocked', async () => {
  const t = await setup({ blockedModels: ['*fable*'] });
  try {
    const lane = await t.post('k-fam', FABLE);
    await lane.text();
    assert.equal(lane.status, 200);
    const jp = await t.post('k-92', FABLE);
    await jp.text();
    assert.equal(jp.status, 400, 'the operator\'s blocklist still applies to what would be sent');
    assert.deepEqual(t.seen, [OPUS]);
  } finally { t.close(); }
});

test('an allowed client\'s advisor-only Fable falls back on 529 too', async () => {
  const t = await setup({ fable529: true });
  try {
    const res = await t.post('k-92', OPUS, { tools: [{ type: 'advisor_20260301', name: 'advisor', model: FABLE }] });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.raws.length, 2, 'one Fable attempt, then the fallback');
    assert.equal(JSON.parse(t.raws[1].raw).tools[0].model, OPUS);
  } finally { t.close(); }
});

// ── round 3 (cross-model pass 2, Oracle, security scan) ───────────────────
test('uninspectable bodies from a lane are refused, never forwarded: broken JSON naming Fable, a compression bomb', async () => {
  const t = await setup();
  try {
    const bomb = zlib.gzipSync(Buffer.concat([Buffer.from('{"model":"' + FABLE + '","pad":"'), Buffer.alloc(80 * 1024 * 1024, 0x61), Buffer.from('"}')]));
    for (const [what, buf, h] of [['broken', `{"model":"${FABLE}",}`, {}], ['bomb', bomb, { 'content-encoding': 'gzip' }]]) {
      const res = await t.postRaw('k-fam', buf, h);
      await res.text();
      assert.equal(res.status, 415, what);
    }
    assert.equal(t.raws.length, 0);
  } finally { t.close(); }
});

test('a leading BOM cannot hide Fable', async () => {
  const t = await setup();
  try {
    await (await t.postRaw('k-fam', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`{"model":"${FABLE}","messages":[]}`)]))).text();
    noFableUpstream(t);
  } finally { t.close(); }
});

test('clearing the allow list (fable: {}) or setting only fable.model turns rationing OFF, not on for everyone', async () => {
  for (const fable of [{}, { model: 'claude-sonnet-5-5' }]) {
    const t = await setup({ fable });
    try {
      await (await t.post('k-fam', FABLE)).text();
      assert.deepEqual(t.seen, [FABLE], JSON.stringify(fable));
    } finally { t.close(); }
  }
});

test('an allowed client\'s gzip Fable still gets the 529 fallback', async () => {
  const t = await setup({ fable529: true });
  try {
    const res = await t.postRaw('k-92', zlib.gzipSync(JSON.stringify({ model: FABLE, messages: [] })), { 'content-encoding': 'gzip' });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.raws.length, 2);
    assert.equal(JSON.parse(t.raws[1].raw).model, OPUS);
  } finally { t.close(); }
});

test('a fallback cannot be mapped back to Fable by an account modelMap', async () => {
  const t = await setup({ fableSpent: true, modelMap: { [OPUS]: FABLE } });
  try {
    await (await t.post('k-92', FABLE)).text();
    noFableUpstream(t);
  } finally { t.close(); }
});

test('an allowed client\'s gzip Fable with no Fable allowance left falls back up front', async () => {
  const t = await setup({ fableSpent: true });
  try {
    const res = await t.postRaw('k-wz', zlib.gzipSync(JSON.stringify({ model: FABLE, messages: [] })), { 'content-encoding': 'gzip' });
    await res.text();
    assert.equal(res.status, 200);
    noFableUpstream(t);
    assert.ok(t.logs.some((l) => /Fable fallback: .* for "jp-wakizashi" — no account has Fable allowance left/.test(l)), t.logs.join('\n'));
  } finally { t.close(); }
});

// ── Oracle should-fixes at b1c115e ────────────────────────────────────────
test('conversation history is not rewritten or counted: a past tool_use input that names Fable stays as the client wrote it', async () => {
  const t = await setup();
  try {
    // A complete exchange: the proxy repairs an orphaned tool_use, which would hide what this checks.
    const history = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { model: FABLE, prompt: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    ];
    await (await t.post('k-fam', OPUS, { messages: history })).text();
    assert.equal(JSON.parse(t.raws[0].raw).messages[1].content[0].input.model, FABLE, 'history untouched');
    assert.ok(!t.logs.some((l) => /Fable (rewritten|fallback)/.test(l)), 'not counted as a rewrite');
    assert.equal((await t.status()).fable.rewritten, 0);
  } finally { t.close(); }
});

test('a non-JSON upload that mentions Fable is passed through, not refused', async () => {
  const t = await setup();
  try {
    const multipart = '--b\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\n\r\nclaude-fable-5 notes \\u0041\r\n--b--\r\n';
    const res = await t.postRaw('k-fam', multipart, { 'content-type': 'multipart/form-data; boundary=b' });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.raws[0].raw, multipart, 'byte-for-byte');
  } finally { t.close(); }
});

test('a "Model" key in any case is rewritten too', async () => {
  const t = await setup();
  try {
    await (await t.postRaw('k-fam', `{"Model":"${FABLE}","messages":[]}`)).text();
    noFableUpstream(t);
  } finally { t.close(); }
});
