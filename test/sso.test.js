import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createSsoGate, ssoPolicy, ssoEligiblePath, SSO_MIN_SECRET } from '../src/sso.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { ensureListenerCerts, listenerHosts, createTlsListener } from '../src/tls-listener.js';
import { publicSettings, applySettingsChanges, MASK } from '../src/settings.js';

// Dashboard SSO (2026-10-26): Authelia's Remote-User, relayed by the Caddy
// front proxy, signs the operator in — believed only from that hop (its
// address, TLS, the hop secret) and only on the dashboard's routes.

process.env.TEAMCLAUDE_CONFIG = join(mkdtempSync(join(tmpdir(), 'tc-sso-home-')), 'teamclaude.json');
after(() => rmSync(dirname(/** @type {string} */ (process.env.TEAMCLAUDE_CONFIG)), { recursive: true, force: true }));

const SECRET = 's'.repeat(SSO_MIN_SECRET);
const SSO = { users: ['jp'], from: ['127.0.0.1'], secret: SECRET };
const HOP = { 'x-teamclaude-sso': SECRET, 'remote-user': 'jp' };

/** A request as the gate sees it. */
const req = ({ headers = HOP, url = '/teamclaude/status', peer = '127.0.0.1', tls = true } = {}) =>
  ({ headers, url, socket: { remoteAddress: peer, encrypted: tls || undefined } });

test('ssoPolicy: off until users, from and a long enough secret are all set', () => {
  for (const off of [undefined, {}, { sso: null }, { sso: { ...SSO, users: [] } }, { sso: { ...SSO, from: [] } },
    { sso: { ...SSO, secret: undefined } }, { sso: { ...SSO, secret: 's'.repeat(SSO_MIN_SECRET - 1) } }, { sso: { ...SSO, users: [' ', 7] } }]) {
    assert.equal(ssoPolicy(off), null, JSON.stringify(off));
  }
  const p = ssoPolicy({ sso: { ...SSO, from: ['::ffff:10.0.6.11'] } });
  assert.deepEqual([...p.from], ['10.0.6.11'], 'v4-mapped written either way');
  assert.equal(p.requireTls, true, 'TLS required unless switched off');
  assert.equal(ssoPolicy({ sso: { ...SSO, requireTls: false } }).requireTls, false);
});

test('ssoEligiblePath: the dashboard\'s control plane only', () => {
  for (const ok of ['/teamclaude/status', '/teamclaude/logs?x=1', '/teamclaude/account', '/teamclaude/settings']) assert.equal(ssoEligiblePath(ok), true, ok);
  for (const no of ['/v1/messages', '/teamclaude/mcp', '/teamclaude/mcp/x', '/teamclaude', '/ui', 'https://api.anthropic.com/teamclaude/status', '', undefined]) {
    assert.equal(ssoEligiblePath(no), false, String(no));
  }
});

test('the gate believes Remote-User only when every condition holds', () => {
  const logs = [];
  const sso = createSsoGate((m) => logs.push(m));
  const cfg = { sso: SSO };
  assert.equal(sso(req(), cfg), 'jp');
  assert.equal(sso(req({ headers: { 'remote-user': 'jp' } }), cfg), null, 'no hop secret: not even considered');
  assert.equal(sso(req({ headers: { ...HOP, 'x-teamclaude-sso': SECRET + 'x' } }), cfg), null, 'wrong secret');
  assert.equal(sso(req({ headers: { ...HOP, 'x-teamclaude-sso': [SECRET, SECRET] } }), cfg), null, 'two secrets');
  assert.equal(sso(req({ peer: '10.0.6.50' }), cfg), null, 'another LAN host');
  assert.equal(sso(req({ tls: false }), cfg), null, 'plain HTTP while TLS is required');
  assert.equal(sso(req({ tls: false }), { sso: { ...SSO, requireTls: false } }), 'jp', 'requireTls: false');
  assert.equal(sso(req({ peer: '::ffff:127.0.0.1' }), cfg), 'jp', 'v4-mapped peer');
  assert.equal(sso(req({ url: '/v1/messages' }), cfg), null, 'not a dashboard route');
  assert.equal(sso(req({ headers: { ...HOP, 'remote-user': 'mallory' } }), cfg), null, 'not an allowed user');
  assert.equal(sso(req({ headers: { ...HOP, 'remote-user': 'jp, mallory' } }), cfg), null, 'joined duplicate headers');
  assert.equal(sso(req({ headers: { ...HOP, 'remote-user': 'jp\nforged' } }), cfg), null, 'control characters');
  assert.equal(sso(req({ headers: { 'x-teamclaude-sso': SECRET } }), cfg), null, 'no user');
  assert.equal(sso(req(), {}), null, 'SSO not configured');
  // Refusals are logged once a minute per reason, and say nothing of the values.
  assert.ok(logs.some((l) => /refused: wrong hop secret/.test(l)));
  assert.ok(logs.every((l) => !l.includes(SECRET) && !l.includes('mallory') && !l.includes('\n')), logs.join('|'));
  const before = logs.length;
  sso(req({ peer: '10.0.6.50' }), cfg);
  assert.equal(logs.length, before, 'the same refusal again within a minute is not logged');
  assert.equal(logs.filter((l) => /signed in via SSO as "jp"/.test(l)).length, 1, 'an admission is logged once an hour');
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

/** A proxy whose only way in from loopback is a key or SSO (trustLoopback off). */
function proxyWith(sso, hooks = {}) {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }], 0.98);
  return createProxyServer(am, {
    proxy: { apiKey: 'shared-k', clientKeys: [{ name: 'lane', key: 'k-lane' }], trustLoopback: false, sso },
    upstream: 'http://127.0.0.1:9',
  }, hooks);
}

async function plain(sso, fn, hooks) {
  const proxy = proxyWith(sso, hooks);
  const port = await listen(proxy);
  const call = (path, { method = 'GET', headers = {}, body } = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
  try { await fn({ call, port }); } finally { proxy.close(); }
}

test('over plain HTTP with requireTls off: SSO is the operator on the dashboard routes, and nowhere else', async () => {
  const settings = { getSettings: async () => ({}), saveSettings: async () => ({ applied: [], needsRestart: [] }) };
  await plain({ ...SSO, requireTls: false }, async ({ call }) => {
    const st = await call('/teamclaude/status', { headers: HOP });
    assert.equal(st.status, 200);
    assert.deepEqual((await st.json()).caller, { kind: 'operator', client: null, refused: [], sso: 'jp' });
    assert.equal((await (await call('/teamclaude/settings', { headers: HOP })).json()).canEdit, true, 'the operator may edit settings');
    // An operator-only control passes every gate (404: no such account).
    const acct = await call('/teamclaude/account', { method: 'POST', headers: { ...HOP, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ name: 'zz', disabled: true }) });
    assert.equal(acct.status, 404);
    // The model API stays key-only: refused before anything is forwarded.
    const v1 = await call('/v1/messages', { method: 'POST', headers: { ...HOP, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(v1.status, 401);
    // A ticket carries a key into /ui; an SSO sign-in has none to hand over —
    // nor does a stale key that rode along with it.
    assert.equal((await call('/teamclaude/ui-ticket', { method: 'POST', headers: HOP })).status, 400);
    assert.equal((await call('/teamclaude/ui-ticket', { method: 'POST', headers: { ...HOP, 'x-api-key': 'stale' } })).status, 400);
    // A page on another origin rides the browser's cookie: refused, reads included.
    assert.equal((await call('/teamclaude/status', { headers: { ...HOP, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })).status, 403);
    // Wrong hop secret or user: the plain key gate answers.
    assert.equal((await call('/teamclaude/status', { headers: { ...HOP, 'x-teamclaude-sso': 'x'.repeat(32) } })).status, 401);
    assert.equal((await call('/teamclaude/status', { headers: { ...HOP, 'remote-user': 'mallory' } })).status, 401);
  }, settings);
});

test('a valid key still decides: a client key with SSO headers stays that client', async () => {
  await plain({ ...SSO, requireTls: false }, async ({ call }) => {
    const st = await call('/teamclaude/status', { headers: { ...HOP, 'x-api-key': 'k-lane' } });
    assert.equal((await st.json()).caller.kind, 'client');
    assert.equal((await call('/teamclaude/account', { method: 'POST', headers: { ...HOP, 'x-api-key': 'k-lane' }, body: '{}' })).status, 403);
    // A wrong key does not block a good sign-in (a stale key in the browser).
    assert.equal((await call('/teamclaude/status', { headers: { ...HOP, 'x-api-key': 'stale' } })).status, 200);
  });
});

test('from an address not in sso.from, the headers count for nothing', async () => {
  await plain({ ...SSO, from: ['10.0.6.11'], requireTls: false }, async ({ call }) => {
    assert.equal((await call('/teamclaude/status', { headers: HOP })).status, 401);
  });
});

test('duplicate Remote-User lines on the wire are refused', async () => {
  await plain({ ...SSO, requireTls: false }, async ({ port }) => {
    const raw = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => s.end(`GET /teamclaude/status HTTP/1.1\r\nHost: x\r\nX-Teamclaude-Sso: ${SECRET}\r\nRemote-User: jp\r\nRemote-User: mallory\r\nConnection: close\r\n\r\n`));
      let buf = ''; s.on('data', (d) => { buf += d; }); s.on('end', () => resolve(buf)); s.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 401/);
  });
});

test('TLS is required by default: plain HTTP is refused, the TLS listener admits', async () => {
  await plain(SSO, async ({ call }) => {
    assert.equal((await call('/teamclaude/status', { headers: HOP })).status, 401);
  });
  const dir = await mkdtemp(join(tmpdir(), 'tc-sso-tls-'));
  const proxy = proxyWith(SSO);
  const creds = await ensureListenerCerts(listenerHosts({ hosts: [] }), dir);
  const ca = await readFile(creds.caPath, 'utf8');
  const tlsSrv = createTlsListener(proxy, creds, () => {});
  const port = await listen(tlsSrv);
  try {
    const got = await new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: '/teamclaude/status', ca, servername: 'localhost', headers: HOP }, (res) => {
        let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal(got.status, 200);
    assert.equal(JSON.parse(got.body).caller.sso, 'jp');
  } finally { tlsSrv.close(); proxy.close(); await rm(dir, { recursive: true, force: true }); }
});

test('settings: the hop secret is write-only, at least 32 characters, and proxy.sso is not "unknown"', () => {
  const cfg = { proxy: { apiKey: 'k', sso: { ...SSO, requireTls: true } } };
  const pub = publicSettings(cfg);
  const field = (k) => pub.fields.find((f) => f.key === k);
  assert.equal(field('proxy.sso.secret').value, MASK);
  assert.deepEqual(field('proxy.sso.users').value, ['jp']);
  assert.ok(!JSON.stringify(pub).includes(SECRET), 'the secret never leaves');
  assert.deepEqual(pub.unknown, []);
  assert.deepEqual(publicSettings({ proxy: { sso: { ...SSO, typo: 1 } } }).unknown, ['proxy.sso.typo']);
  assert.throws(() => applySettingsChanges(JSON.parse(JSON.stringify(cfg)), { set: { 'proxy.sso.secret': 'short' } }), /at least 32/);
  const next = JSON.parse(JSON.stringify(cfg));
  applySettingsChanges(next, { set: { 'proxy.sso.secret': MASK, 'proxy.sso.users': ['jp', 'admin'] } });
  assert.equal(next.proxy.sso.secret, SECRET, 'the mask keeps the stored secret');
  assert.deepEqual(next.proxy.sso.users, ['jp', 'admin']);
});
