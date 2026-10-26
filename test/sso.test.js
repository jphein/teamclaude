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
const HOP = { 'x-teamclaude-sso': SECRET, 'remote-user': 'jp', 'sec-fetch-site': 'same-origin' };

/** A request as the gate sees it. */
const req = ({ headers = HOP, url = '/teamclaude/status', method = 'GET', peer = '127.0.0.1', tls = true } = {}) =>
  ({ headers, url, method, socket: { remoteAddress: peer, encrypted: tls || undefined } });

test('ssoPolicy: off until users, from and a long enough secret are all set', () => {
  for (const off of [undefined, {}, { sso: null }, { sso: { ...SSO, users: [] } }, { sso: { ...SSO, from: [] } },
    { sso: { ...SSO, secret: undefined } }, { sso: { ...SSO, secret: 's'.repeat(SSO_MIN_SECRET - 1) } }, { sso: { ...SSO, users: [' ', 7] } }]) {
    assert.equal(ssoPolicy(off), null, JSON.stringify(off));
  }
  const p = ssoPolicy({ sso: { ...SSO, from: ['::ffff:10.0.6.11'] } });
  assert.deepEqual([...p.from], ['10.0.6.11'], 'v4-mapped written either way');
  assert.equal(p.requireTls, true, 'TLS required unless switched off');
  assert.equal(ssoPolicy({ sso: { ...SSO, requireTls: false } }).requireTls, false);
  // Plain HTTP only from this machine: across the LAN the secret would travel in clear.
  assert.equal(ssoPolicy({ sso: { ...SSO, from: ['10.0.6.11'], requireTls: false } }), null);
  assert.equal(ssoPolicy({ sso: { ...SSO, from: ['127.0.0.1', '10.0.6.11'], requireTls: false } }), null);
  assert.ok(ssoPolicy({ sso: { ...SSO, from: ['::1', '127.0.0.2'], requireTls: false } }));
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
  assert.equal(sso(req({ headers: { 'x-teamclaude-sso': SECRET, 'sec-fetch-site': 'same-origin' } }), cfg), null, 'no user');
  // The cookie is the parent domain's: only the dashboard page itself counts.
  const site = (v, method = 'GET') => sso(req({ method, headers: { 'x-teamclaude-sso': SECRET, 'remote-user': 'jp', ...(v ? { 'sec-fetch-site': v } : {}) } }), cfg);
  assert.equal(site(undefined), null, 'no fetch metadata (not a browser page): refused');
  assert.equal(site('same-site'), null, 'a sibling *.realm.watch page');
  assert.equal(site('cross-site'), null);
  assert.equal(site('none'), 'jp', 'an address the person typed may read');
  assert.equal(site('none', 'POST'), null, '…not write');
  assert.equal(site('same-origin', 'POST'), 'jp');
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
function proxyWith(sso, hooks = {}, upstream = 'http://127.0.0.1:9') {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'sk-test' }], 0.98);
  return createProxyServer(am, {
    proxy: { apiKey: 'shared-k', clientKeys: [{ name: 'lane', key: 'k-lane' }], trustLoopback: false, sso },
    upstream,
  }, hooks);
}

async function plain(sso, fn, hooks, upstream) {
  const proxy = proxyWith(sso, hooks, upstream);
  const port = await listen(proxy);
  const call = (path, { method = 'GET', headers = {}, body } = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
  try { await fn({ call, port }); } finally { proxy.close(); }
}

test('over plain HTTP with requireTls off: SSO is the operator on the dashboard routes, and nowhere else', async () => {
  const settings = { getSettings: async () => ({}), saveSettings: async () => ({ applied: [], needsRestart: [] }) };
  await plain({ ...SSO, requireTls: false }, async ({ call }) => {
    const st = await call('/teamclaude/status', { headers: HOP });
    assert.equal(st.status, 200);
    const caller = (await st.json()).caller;
    assert.equal(caller.kind, 'operator');
    assert.equal(caller.sso, 'jp');
    assert.ok(caller.refused.includes('/teamclaude/add-account'), 'what SSO may not do is listed, so the page hides it');
    assert.equal((await (await call('/teamclaude/settings', { headers: HOP })).json()).canEdit, true, 'the operator may edit settings');
    // An operator-only control passes every gate (404: no such account).
    const acct = await call('/teamclaude/account', { method: 'POST', headers: { ...HOP, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ name: 'zz', disabled: true }) });
    assert.equal(acct.status, 404);
    // The model API stays key-only: refused before anything is forwarded.
    const v1 = await call('/v1/messages', { method: 'POST', headers: { ...HOP, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(v1.status, 401);
    // A ticket carries a key into /ui; an SSO sign-in has none to hand over —
    // nor does a stale key that rode along with it.
    assert.equal((await call('/teamclaude/ui-ticket', { method: 'POST', headers: HOP })).status, 403);
    assert.equal((await call('/teamclaude/ui-ticket', { method: 'POST', headers: { ...HOP, 'x-api-key': 'stale' } })).status, 403);
    // A page on a sibling site rides the parent-domain cookie: not signed in, reads included.
    assert.equal((await call('/teamclaude/status', { headers: { ...HOP, origin: 'https://plan.realm.watch', 'sec-fetch-site': 'same-site' } })).status, 401);
    assert.equal((await call('/teamclaude/account', { method: 'POST', headers: { ...HOP, origin: 'https://plan.realm.watch', 'sec-fetch-site': 'same-site' }, body: '{}' })).status, 401);
    // Wrong hop secret or user: the plain key gate answers.
    assert.equal((await call('/teamclaude/status', { headers: { ...HOP, 'x-teamclaude-sso': 'x'.repeat(32) } })).status, 401);
    assert.equal((await call('/teamclaude/status', { headers: { ...HOP, 'remote-user': 'mallory' } })).status, 401);
  }, settings);
});

test('an SSO sign-in may not change danger settings or add accounts; the key still may', async () => {
  const saved = [];
  const reauthCalls = [];
  const settings = {
    getSettings: async () => ({}), saveSettings: async (c) => { saved.push(c); return { applied: Object.keys(c.set || {}), needsRestart: [] }; },
    reauth: { start: async (...a) => { reauthCalls.push(a); return { authUrl: 'https://claude.ai/x' }; }, status: () => ({}) },
  };
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    await plain({ ...SSO, requireTls: false }, async ({ call }) => {
      const post = (path, body, headers = HOP) => call(path, { method: 'POST', headers: { ...headers, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const st = await (await call('/teamclaude/status', { headers: HOP })).json();
      assert.deepEqual(st.caller.refused.sort(), ['/teamclaude/add-account', '/teamclaude/add-account/cancel', '/teamclaude/add-account/code', '/teamclaude/ui-ticket']);
      assert.ok((await (await call('/teamclaude/settings', { headers: HOP })).json()).ssoEditable.includes('switchThreshold'));
      for (const body of [
        { set: { 'service.restart': { command: ['/bin/true'] } } },
        { set: { upstream: 'https://evil.example' } },
        { set: { 'proxy.sso.users': ['mallory'] } },
        { set: { switchThreshold: 0.9, 'proxy.apiKey': 'x'.repeat(40) } },
        { accounts: [{ id: 'a', upstream: 'https://evil.example' }] },
        // Oracle round 3, both confirmed live before the allowlist:
        { set: { 'service.logs': { file: '/home/jp/.config/teamclaude.json' } } },
        { set: { 'proxy.clientKeys': [{ name: 'mine', key: 'k'.repeat(40) }] } },
        // …and the rest of what a blocklist kept missing:
        { set: { autoUpdate: true } }, { set: { 'egress.checkUrl': 'https://evil.example' } }, { set: { noProxy: ['*'] } },
        { set: { 'sx.apiKey': 'x' } }, { set: { warmTransport: 'claude' } }, { set: { logLevel: 'debug' } },
        { accounts: [{ id: 'a', modelMap: {} }] }, { accounts: [{ id: 'a', maxSpend: 1000 }] },
        { set: {}, somethingElse: 1 },
        { set: { 'failover.model': 'openai/gpt-x' } },
        { set: { 'failover.excludeClients': [] } }, { set: { 'proxy.sessionDetail': true } },
        { set: { quotaProbeSeconds: 1 } }, { set: { routes: [{ name: 'r', match: ['*'], upstream: 'https://evil.example' }] } },
      ]) {
        const r = await post('/teamclaude/settings', body);
        assert.equal(r.status, 403, JSON.stringify(body));
      }
      assert.equal(saved.length, 0, 'nothing dangerous was saved');
      // An ordinary setting is fine, and the log names the SSO user.
      assert.equal((await post('/teamclaude/settings', { set: { switchThreshold: 0.9 } })).status, 200);
      assert.equal((await post('/teamclaude/settings', { accounts: [{ id: 'a', priority: 2, disabled: false }], order: ['a'] })).status, 200);
      assert.ok(logs.some((l) => /Settings saved via SSO as "jp": switchThreshold/.test(l)), logs.join('|'));
      assert.equal((await post('/teamclaude/add-account', {})).status, 403);
      // Reauth is open to SSO, but strict: the hook is told so.
      assert.equal((await post('/teamclaude/reauth', { name: 'a' })).status, 200);
      assert.deepEqual(reauthCalls.at(-1), ['a', { strict: true }]);
      assert.equal((await post('/teamclaude/reauth', { name: 'a' }, { 'x-api-key': 'shared-k' })).status, 200);
      assert.deepEqual(reauthCalls.at(-1), ['a', { strict: false }]);
      // The shared key may do both.
      const keyed = { 'x-api-key': 'shared-k' };
      assert.equal((await post('/teamclaude/settings', { set: { upstream: 'https://api.anthropic.com' } }, keyed)).status, 200);
    }, settings);
  } finally { console.log = orig; }
});

test('the gate reads the live config on every request: a reload rotates, narrows or removes SSO at once', async () => {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'sk-test' }], 0.98);
  const config = { proxy: { apiKey: 'shared-k', trustLoopback: false, sso: { ...SSO, requireTls: false } }, upstream: 'http://127.0.0.1:9' };
  const proxy = createProxyServer(am, config, {});
  const port = await listen(proxy);
  const status = (headers) => fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers }).then(r => r.status);
  const NEW = 'n'.repeat(SSO_MIN_SECRET);
  try {
    assert.equal(await status(HOP), 200);
    // What index.js's reload does: replace proxy.sso on the same object.
    config.proxy.sso = { ...SSO, secret: NEW, requireTls: false };
    assert.equal(await status(HOP), 401, 'the old secret is refused at once');
    assert.equal(await status({ ...HOP, 'x-teamclaude-sso': NEW }), 200, 'the new one admits');
    config.proxy.sso = { ...SSO, users: ['someone-else'], secret: NEW, requireTls: false };
    assert.equal(await status({ ...HOP, 'x-teamclaude-sso': NEW }), 401, 'a removed user is refused at once');
    for (const off of [undefined, { users: ['jp'] }, { ...SSO, secret: 'short', requireTls: false }]) {
      config.proxy.sso = off;
      assert.equal(await status({ ...HOP, 'x-teamclaude-sso': NEW }), 401, `missing or malformed is off: ${JSON.stringify(off)}`);
    }
  } finally { proxy.close(); }
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
  await plain({ ...SSO, from: ['127.0.0.2'], requireTls: false }, async ({ call }) => {
    assert.equal((await call('/teamclaude/status', { headers: HOP })).status, 401);
  });
});

test('the front proxy\'s headers are never relayed upstream', async () => {
  const seen = [];
  const up = (await import('node:http')).createServer((rq, rs) => {
    seen.push(rq.headers);
    rs.writeHead(200, { 'content-type': 'application/json' });
    rs.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upPort = await listen(up);
  try {
    await plain({ ...SSO, requireTls: false }, async ({ call }) => {
      const r = await call('/v1/messages', {
        method: 'POST',
        headers: { ...HOP, 'x-api-key': 'shared-k', 'remote-groups': 'admins', 'remote-email': 'e@x', 'remote-name': 'J', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await r.text();
      assert.equal(r.status, 200);
    }, undefined, `http://127.0.0.1:${upPort}`);
    assert.equal(seen.length, 1, 'the request reached the stub upstream');
    for (const h of ['x-teamclaude-sso', 'remote-user', 'remote-groups', 'remote-email', 'remote-name']) assert.equal(seen[0][h], undefined, h);
  } finally { up.close(); }
});

/** One raw HTTP/1.1 request, exactly as written (fetch would normalise the path). */
const rawGet = (port, path, extra = '') => new Promise((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1', () => s.end(`GET ${path} HTTP/1.1\r\nHost: x\r\nSec-Fetch-Site: same-origin\r\nX-Teamclaude-Sso: ${SECRET}\r\nRemote-User: jp\r\n${extra}Connection: close\r\n\r\n`));
  let buf = ''; s.on('data', (d) => { buf += d; }); s.on('end', () => resolve(buf)); s.on('error', reject);
});

test('a dot-segment path is never signed in, and nothing SSO-admitted reaches the forwarder', async () => {
  let hits = 0;
  const up = (await import('node:http')).createServer((rq, rs) => { hits++; rs.end('{}'); });
  const upPort = await listen(up);
  try {
    await plain({ ...SSO, requireTls: false }, async ({ port }) => {
      assert.match(await rawGet(port, '/teamclaude/status'), /^HTTP\/1\.1 200/, 'positive control');
      for (const p of ['/teamclaude/../v1/messages', '/teamclaude/%2e%2e/v1/messages', '/teamclaude/..%2fv1/messages', '/teamclaude/../teamclaude/mcp', '/teamclaude/./status']) {
        assert.match(await rawGet(port, p), /^HTTP\/1\.1 401/, p);
      }
      assert.match(await rawGet(port, '/teamclaude/no-such-route'), /^HTTP\/1\.1 404/);
    }, undefined, `http://127.0.0.1:${upPort}`);
    assert.equal(hits, 0, 'the upstream was never reached');
  } finally { up.close(); }
});

test('a WebSocket upgrade relays none of the front proxy\'s headers', async () => {
  const seen = [];
  const up = (await import('node:http')).createServer();
  up.on('upgrade', (rq, sock) => { seen.push(rq.headers); sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  const upPort = await listen(up);
  try {
    await plain({ ...SSO, requireTls: false }, async ({ port }) => {
      await new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET /v1/sessions/ws HTTP/1.1\r\nHost: x\r\nX-Api-Key: shared-k\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Teamclaude-Sso: ${SECRET}\r\nRemote-User: jp\r\nRemote-Groups: admins\r\n\r\n`));
        s.on('data', () => s.destroy()); s.on('close', resolve); s.on('error', reject);
        setTimeout(() => s.destroy(), 3000);
      });
    }, undefined, `http://127.0.0.1:${upPort}`);
    assert.equal(seen.length, 1, 'the handshake reached the stub upstream');
    for (const h of ['x-teamclaude-sso', 'remote-user', 'remote-groups']) assert.equal(seen[0][h], undefined, h);
  } finally { up.close(); }
});

test('duplicate Remote-User lines on the wire are refused', async () => {
  await plain({ ...SSO, requireTls: false }, async ({ port }) => {
    const raw = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => s.end(`GET /teamclaude/status HTTP/1.1\r\nHost: x\r\nSec-Fetch-Site: same-origin\r\nX-Teamclaude-Sso: ${SECRET}\r\nRemote-User: jp\r\nRemote-User: mallory\r\nConnection: close\r\n\r\n`));
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
