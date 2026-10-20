import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { modelFamily, isMythosModel } from '../src/model.js';
import { familyPolicy, isFamilyRefusal, FamilyStats } from '../src/family-policy.js';
import { publicSettings, applySettingsChanges } from '../src/settings.js';

// Mythos as a model family (JP, 2026-10-20: "we need to add mythos support to
// teamclaude"): rationed like Fable — rewritten, never refused — and an
// account upstream refuses Mythos on is benched for Mythos only.

const MYTHOS = 'claude-mythos-5-1';
const FABLE = 'claude-fable-5-1';
const OPUS = 'claude-opus-5-5';

test('modelFamily names Mythos; isMythosModel matches Mythos ids only', () => {
  assert.equal(modelFamily(MYTHOS), 'mythos');
  assert.equal(modelFamily('claude-mythos-5'), 'mythos');
  assert.equal(modelFamily(FABLE), 'fable');
  assert.ok(isMythosModel('Claude-MYTHOS-x'));
  assert.ok(!isMythosModel(OPUS) && !isMythosModel(null));
});

test('a learned Mythos weekly bucket gates Mythos only', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  const a = am.accounts[0];
  a.probing = false;
  a.quota.scopedWeekly = { mythos: { utilization: 1, resetAt: Date.now() + 86_400_000 } };
  assert.equal(am._isAvailable(a, MYTHOS), false, 'spent Mythos bucket bars Mythos');
  assert.equal(am._isAvailable(a, OPUS), true, 'and nothing else');
});

test('policy: Mythos falls back to Opus by default; a Mythos fallback is refused; fallbackOnCapacity defaults on', () => {
  assert.equal(familyPolicy({}, 'mythos').enabled, false);
  const p = familyPolicy({ mythos: { allow: ['jp-92'], model: 'claude-mythos-5' } }, 'mythos');
  assert.equal(p.model, OPUS);
  assert.equal(p.fallbackOnCapacity, true);
  assert.equal(familyPolicy({ mythos: { allow: [], fallbackOnCapacity: false } }, 'mythos').fallbackOnCapacity, false);
  assert.equal(familyPolicy({ mythos: { allow: [], model: FABLE } }, 'mythos').model, FABLE, 'a Fable fallback is allowed');
});

test('isFamilyRefusal: 403 permission_error / 404 not_found_error naming the model; nothing else', () => {
  const b = (type, message) => JSON.stringify({ type: 'error', error: { type, message } });
  assert.ok(isFamilyRefusal(403, b('permission_error', `Your account does not have access to ${MYTHOS}`), MYTHOS));
  assert.ok(isFamilyRefusal(404, b('not_found_error', `model: ${MYTHOS}`), MYTHOS));
  assert.ok(!isFamilyRefusal(403, b('permission_error', 'Request not allowed'), MYTHOS), 'an account-wide 403 is not a family refusal');
  assert.ok(!isFamilyRefusal(404, b('not_found_error', 'no such file'), MYTHOS));
  assert.ok(!isFamilyRefusal(429, b('rate_limit_error', MYTHOS), MYTHOS));
  assert.ok(!isFamilyRefusal(403, 'not json', MYTHOS));
});

test('FamilyStats: per-client counts over the last 24 hours, older hours dropped', () => {
  let now = new Date(2026, 9, 20, 10, 0, 0);
  const st = new FamilyStats(() => now);
  st.record('rewrite', { client: 'familiar', from: MYTHOS, to: OPUS, reason: 'x' });
  st.record('rewrite', { client: null, from: MYTHOS, to: OPUS, reason: 'x' });
  now = new Date(2026, 9, 20, 20, 0, 0);
  st.record('fallback', { client: 'jp-92', from: MYTHOS, to: OPUS, reason: 'y' });
  assert.deepEqual(st.byClient24h(), { familiar: { rewritten: 1, fallbacks: 0 }, '(shared key)': { rewritten: 1, fallbacks: 0 }, 'jp-92': { rewritten: 0, fallbacks: 1 } });
  now = new Date(2026, 9, 21, 10, 30, 0);
  assert.deepEqual(st.byClient24h(), { 'jp-92': { rewritten: 0, fallbacks: 1 } });
});

// ── through the real proxy ───────────────────────────────────────────────
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

/** refuse: account names upstream refuses Mythos on (403 permission_error). */
async function setup({ mythos = { allow: ['jp-92'] }, fable, refuse = [], refuseStatus = 403, mythos529 = false, modelMap } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let m = null; try { m = JSON.parse(Buffer.concat(chunks).toString('utf8')).model; } catch { /* */ }
      const acct = /t-(\w+)/.exec(req.headers.authorization || '')?.[1] ?? '?';
      seen.push(`${acct}:${m}`);
      if (isMythosModel(m) && refuse.includes(acct)) {
        const type = refuseStatus === 403 ? 'permission_error' : 'not_found_error';
        res.writeHead(refuseStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type, message: `This organization does not have access to model ${m}` } }));
        return;
      }
      if (mythos529 && isMythosModel(m)) {
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
  const config = {
    proxy: { apiKey: 'shared-k', clientKeys: [{ name: 'familiar', key: 'k-fam' }, { name: 'jp-92', key: 'k-92' }] },
    upstream: `http://127.0.0.1:${upPort}`,
    ...(mythos === null ? {} : { mythos }),
    ...(fable ? { fable } : {}),
  };
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  const proxy = createProxyServer(am, config, {});
  const port = await listen(proxy);
  return {
    am, seen, logs,
    post: (key, model) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    }),
    status: () => fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'shared-k' } }).then((r) => r.json()),
    close() { console.log = orig; proxy.close(); upstream.close(); },
  };
}
const models = (seen) => seen.map((x) => x.split(':')[1]);

test('a lane asking for Mythos is served as Opus — never refused — logged and counted per client', async () => {
  const t = await setup();
  try {
    const res = await t.post('k-fam', MYTHOS);
    await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(models(t.seen), [OPUS]);
    assert.ok(t.logs.some((l) => /Mythos rewritten: claude-mythos-5-1 → claude-opus-5-5 for "familiar" — not on mythos\.allow/.test(l)), t.logs.join('\n'));
    const st = await t.status();
    assert.equal(st.mythos.rewritten, 1);
    assert.deepEqual(st.mythos.byClient24h, { familiar: { rewritten: 1, fallbacks: 0 } });
    assert.equal(st.fable.rewritten, 0, 'Fable counters untouched');
  } finally { t.close(); }
});

test('an allowed client keeps Mythos; with no mythos block nobody is rationed', async () => {
  const t = await setup();
  try {
    await (await t.post('k-92', MYTHOS)).text();
    assert.deepEqual(models(t.seen), [MYTHOS]);
  } finally { t.close(); }
  const u = await setup({ mythos: null });
  try {
    await (await u.post('k-fam', MYTHOS)).text();
    assert.deepEqual(models(u.seen), [MYTHOS]);
  } finally { u.close(); }
});

test('a Mythos fallback to Fable is then judged by fable.allow', async () => {
  const t = await setup({ mythos: { allow: ['jp-92'], model: FABLE }, fable: { allow: ['jp-92'] } });
  try {
    await (await t.post('k-fam', MYTHOS)).text();
    await (await t.post('k-92', MYTHOS)).text();
    assert.deepEqual(models(t.seen), [OPUS, MYTHOS], 'the lane ends on Opus (Mythos→Fable→Opus); jp-92 keeps Mythos');
  } finally { t.close(); }
});

test('an account modelMap that maps TO Mythos is caught by the final gate', async () => {
  const t = await setup({ modelMap: { 'sneaky-alias': MYTHOS } });
  try {
    await (await t.post('k-fam', 'sneaky-alias')).text();
    assert.ok(!models(t.seen).some(isMythosModel), `upstream saw Mythos: ${t.seen}`);
  } finally { t.close(); }
});

test('Mythos at capacity (529) for an allowed client is retried once as Opus; fallbackOnCapacity:false passes the 529', async () => {
  const t = await setup({ mythos529: true });
  try {
    const res = await t.post('k-92', MYTHOS);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(models(t.seen).at(-1), OPUS);
    assert.ok(t.logs.some((l) => /Mythos fallback: .* for "jp-92" — upstream 529/.test(l)), t.logs.join('\n'));
  } finally { t.close(); }
  const u = await setup({ mythos529: true, mythos: { allow: ['jp-92'], fallbackOnCapacity: false } });
  try {
    const res = await u.post('k-92', MYTHOS);
    await res.text();
    assert.ok(!models(u.seen).includes(OPUS), `no Opus fallback: ${u.seen}`);
  } finally { u.close(); }
});

test('a Mythos refusal benches that account for Mythos only and the request moves to another account', async () => {
  for (const refuseStatus of [403, 404]) {
    const t = await setup({ refuse: ['a'], refuseStatus });
    try {
      const res = await t.post('k-92', MYTHOS);
      await res.text();
      assert.equal(res.status, 200, `${refuseStatus}: served by b`);
      assert.ok(t.seen.includes(`b:${MYTHOS}`), `${refuseStatus}: ${t.seen}`);
      const a = t.am.accounts.find((x) => x.name === 'a');
      assert.equal(t.am._isAvailable(a, MYTHOS), false, 'a is benched for Mythos');
      assert.equal(t.am._isAvailable(a, OPUS), true, 'a still serves Opus');
      assert.equal(a.entitlementDeniedUntil, null, 'no account-wide entitlement cooldown');
      const st = await t.status();
      assert.ok(st.accounts.find((x) => x.name === 'a').familyDenied.mythos, 'status shows the family denial');
    } finally { t.close(); }
  }
});

test('refused on every account: an allowed client falls back to Opus; with rationing off the refusal reaches the client', async () => {
  const t = await setup({ refuse: ['a', 'b'] });
  try {
    const res = await t.post('k-92', MYTHOS);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(models(t.seen).at(-1), OPUS);
    assert.ok(t.logs.some((l) => /Mythos fallback: .* for "jp-92" — Mythos refused by every account/.test(l)), t.logs.join('\n'));
  } finally { t.close(); }
  const u = await setup({ refuse: ['a', 'b'], mythos: null });
  try {
    const res = await u.post('k-fam', MYTHOS);
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.error.type, 'permission_error');
  } finally { u.close(); }
});

test('settings: the client picker offers names and "(shared key)", never key material; values validate', () => {
  const cfg = { proxy: { apiKey: 'SHARED-SECRET-x', clientKeys: [{ name: 'familiar', key: 'SECRET-fam' }, { name: 'jp-92', key: 'SECRET-92' }] }, mythos: { allow: ['jp-92'] } };
  const pub = publicSettings(cfg);
  const f = pub.fields.find((x) => x.key === 'mythos.allow');
  assert.equal(f.type, 'clients');
  assert.deepEqual(f.options, ['familiar', 'jp-92', '(shared key)']);
  assert.deepEqual(f.value, ['jp-92']);
  const json = JSON.stringify(pub);
  for (const secret of ['SHARED-SECRET-x', 'SECRET-fam', 'SECRET-92']) assert.ok(!json.includes(secret), `payload leaks ${secret}`);
  for (const key of ['fable.fallbackOnCapacity', 'mythos.model', 'mythos.fallbackOnCapacity']) assert.ok(pub.fields.some((x) => x.key === key), key);
  const c2 = JSON.parse(JSON.stringify(cfg));
  applySettingsChanges(c2, { set: { 'mythos.allow': ['familiar', '(shared key)'], 'mythos.fallbackOnCapacity': false } });
  assert.deepEqual(c2.mythos.allow, ['familiar', '(shared key)']);
  assert.equal(c2.mythos.fallbackOnCapacity, false);
  assert.throws(() => applySettingsChanges(JSON.parse(JSON.stringify(cfg)), { set: { 'mythos.model': MYTHOS } }), /must not be a Mythos model/);
  assert.throws(() => applySettingsChanges(JSON.parse(JSON.stringify(cfg)), { set: { 'mythos.allow': [3] } }));
});
