import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, createProxyRequestListener } from '../src/server.js';
import { resolveSigil, gitEnv } from '../src/version-sigil.js';
import { allowLoopbackForward } from '../src/forward-target.js';

// GET /api/version (realm-sigil; CHECK sigil-coverage, realmwatch #493, JP 2026-11-17 05:07).

const KEY = 'test-client-key';
const PROXY = { apiKey: 'test-shared-key', clientKeys: [{ name: 'browser', key: KEY }] };
const REMOTE = '203.0.113.9';
const DOC = { name: 'teamclaude', description: 'TeamClaude proxy', realm: 'fantasy', repo: 'https://github.com/jphein/teamclaude',
  version: 'Radiant Relic · 3d21c19', hash: '3d21c19', dirty: false, commit_url: 'https://github.com/jphein/teamclaude/commit/3d21c19' };

function makeServer(hooks = {}) {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  return createProxyServer(am, { proxy: PROXY, upstream: 'http://127.0.0.1:9' }, hooks);
}

// a request from a non-loopback peer with no key, emitted straight into the server
function request(server, { method = 'GET', url, headers = {}, from = REMOTE }) {
  const req = Readable.from([]);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: from } });
  let done;
  const finished = new Promise(r => { done = r; });
  const res = {
    status: null, headers: {}, chunks: '', writableEnded: false,
    writeHead(status, h) { this.status = status; Object.assign(this.headers, h || {}); return this; },
    write(c) { this.chunks += c; return true; },
    end(c) { if (c) this.chunks += c; this.writableEnded = true; done(); },
    on() { return this; },
  };
  server.emit('request', req, res);
  return finished.then(() => res);
}

// sigil-coverage's own rule (realmwatch plugins/system-updates/sigil_coverage.py _sigil_json)
function passesCoverage(text) {
  const d = JSON.parse(text);
  if (typeof d.version !== 'string' || typeof d.hash !== 'string') return false;
  const m = /^.+ · [0-9a-f]{7,40}$/s.test(d.version);   // _SIGIL = r".+ · [0-9a-f]{7,40}", fullmatch
  const suffix = d.version.split(' · ').pop();
  return m && /^[0-9a-f]{7,40}$/.test(d.hash) && (suffix.startsWith(d.hash) || d.hash.startsWith(suffix));
}

function fakeRoot(git = true) {
  const d = mkdtempSync(join(tmpdir(), 'tc-sigil-'));
  if (git) mkdirSync(join(d, '.git'));
  return d;
}

test('resolveSigil: a checkout names its short hash in the realm-sigil shape, and nothing about the host', async () => {
  const root = fakeRoot();
  const calls = [];
  const doc = await resolveSigil({ root, exec: async (f, a, o) => { calls.push([f, a, o.cwd]); return { stdout: a[0] === 'rev-parse' ? '3d21c19\n' : '' }; } });
  rmSync(root, { recursive: true });
  assert.deepEqual(doc, DOC);
  assert.deepEqual(calls, [['git', ['rev-parse', '--short=7', 'HEAD'], root], ['git', ['status', '--porcelain', '--untracked-files=no'], root]]);
  assert.ok(passesCoverage(JSON.stringify(doc)));
  for (const k of ['host', 'pid', 'uptime', 'os', 'runtime', 'started', 'built']) assert.ok(!(k in doc), k);
});

test('resolveSigil: no checkout, a failing git or a non-hex answer gives hash null, never an invented one', async () => {
  const none = fakeRoot(false);
  let called = false;
  const a = await resolveSigil({ root: none, exec: async () => { called = true; return { stdout: 'abc1234' }; } });
  assert.equal(called, false);
  const root = fakeRoot();
  const b = await resolveSigil({ root, exec: async () => { throw new Error('no git'); } });
  const c = await resolveSigil({ root, exec: async () => ({ stdout: 'v1.4.2\n' }) });
  rmSync(none, { recursive: true }); rmSync(root, { recursive: true });
  for (const d of [a, b, c]) { assert.equal(d.hash, null); assert.equal(d.version, 'teamclaude · unknown'); assert.equal(d.commit_url, null); }
});

test('resolveSigil: a modified checkout says dirty, and an unreadable status is not called clean', async () => {
  const root = fakeRoot();
  const d1 = await resolveSigil({ root, exec: async (f, a) => ({ stdout: a[0] === 'rev-parse' ? '3d21c19\n' : ' M src/server.js\n' }) });
  const d2 = await resolveSigil({ root, exec: async (f, a) => { if (a[0] === 'status') throw new Error('x'); return { stdout: '3d21c19\n' }; } });
  rmSync(root, { recursive: true });
  assert.equal(d1.dirty, true); assert.equal(d2.dirty, true);
});

test('resolveSigil: git never sees GIT_DIR, GIT_WORK_TREE or any other GIT_* that could pick another repository (xreview r1.2)', async () => {
  const root = fakeRoot();
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_INDEX_FILE: '/x', KEEP_ME: '1' });
  const envs = [];
  try { await resolveSigil({ root, exec: async (f, a, o) => { envs.push(o.env); return { stdout: '3d21c19\n' }; } }); }
  finally { for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'KEEP_ME']) if (!(k in saved)) delete process.env[k]; rmSync(root, { recursive: true }); }
  assert.ok(envs.length >= 1);
  for (const e of envs) { assert.ok(!Object.keys(e).some((k) => k.startsWith('GIT_'))); assert.equal(e.KEEP_ME, '1'); }
  assert.deepEqual(Object.keys(gitEnv({ GIT_DIR: 'x', PATH: '/bin' })), ['PATH']);
});

// raw HTTP through the real parser, loopback exemption off (trustLoopback: false), so the key gate applies
async function raw(port, text) {
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));   // no half-close: a forwarding listener reads that as a client gone
    let buf = '';
    s.on('data', (c) => { buf += c; });
    s.on('end', () => res(buf));
    s.on('error', rej);
    s.setTimeout(5000, () => { s.destroy(); res(buf); });
  });
}

test('through the real HTTP parser only the exact GET skips the gate: HEAD, OPTIONS, encodings, dot-segments, absolute-form and aliases stay gated (xreview r1.3)', async () => {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const server = createProxyServer(am, { proxy: { ...PROXY, trustLoopback: false }, upstream: 'http://127.0.0.1:9' }, { resolveSigil: async () => DOC });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const ok = await new Promise((res, rej) => http.get({ port, host: '127.0.0.1', path: '/api/version' }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ status: r.statusCode, body: b }));
    }).on('error', rej));
    assert.equal(ok.status, 200);
    assert.ok(passesCoverage(ok.body));
    for (const line of ['HEAD /api/version', 'OPTIONS /api/version', 'GET /api/%76ersion', 'GET /api/version%2F', 'GET /api/./version', 'GET /api//version',
      'GET /teamrouter/../api/version', 'GET http://x/api/version', 'GET //api/version', 'GET /API/VERSION', 'GET /api/version#x']) {
      const r = await raw(port, `${line} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      const status = Number((r.match(/^HTTP\/1\.1 (\d{3})/) || [])[1]);
      assert.ok(status !== 200 || !/Radiant Relic/.test(r), `${line} answered the version document (status ${status})`);
      assert.ok([400, 401, 404, 405].includes(status) || status >= 500, `${line} → ${status}`);
    }
  } finally { server.close(); }
});

test('the MITM listener has no such route: a decrypted GET /api/version is forwarded upstream (xreview r1.3)', async () => {
  const seen = [];
  const up = http.createServer((q, s) => { seen.push(q.url); s.writeHead(404, { 'content-type': 'application/json' }); s.end('{}'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const upstream = `http://127.0.0.1:${up.address().port}`;
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const proxy = http.createServer(createProxyRequestListener({ accountManager: am, upstream, config: { upstream } }));
  allowLoopbackForward(proxy);   // the fake upstream is on loopback
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const r = await raw(proxy.address().port, 'GET /api/version HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: close\r\n\r\n');
    assert.doesNotMatch(r, /Radiant Relic|realm-sigil|"realm"/);
    assert.deepEqual(seen, ['/api/version']);
  } finally { proxy.close(); up.close(); }
});

test('GET /api/version answers a remote caller with no key; the document passes sigil-coverage', async () => {
  const server = makeServer({ resolveSigil: async () => DOC });
  const r = await request(server, { url: '/api/version' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(r.chunks), DOC);
  assert.ok(passesCoverage(r.chunks));
});

test('only that exact GET skips the key gate: a POST, a query, a neighbouring path and the API stay 401', async () => {
  const server = makeServer({ resolveSigil: async () => DOC });
  for (const [method, url] of [['POST', '/api/version'], ['GET', '/api/version?x=1'], ['GET', '/api/versions'], ['GET', '/api/version/'], ['GET', '/v1/models']]) {
    const r = await request(server, { method, url });
    assert.equal(r.status, 401, `${method} ${url}`);
  }
});

test('the document is resolved once, when the server is created (a later pull cannot rename the running code)', async () => {
  let n = 0;
  const server = makeServer({ resolveSigil: async () => ({ ...DOC, hash: n++ === 0 ? '3d21c19' : 'fffffff' }) });
  const a = JSON.parse((await request(server, { url: '/api/version' })).chunks);
  const b = JSON.parse((await request(server, { url: '/api/version' })).chunks);
  assert.equal(n, 1);
  assert.equal(a.hash, '3d21c19'); assert.equal(b.hash, '3d21c19');
});

test('a resolver that fails answers 503, not a made-up version', async () => {
  const server = makeServer({ resolveSigil: async () => { throw new Error('boom'); } });
  const r = await request(server, { url: '/api/version' });
  assert.equal(r.status, 503);
});

test('this checkout: the default resolver names the real HEAD', async (t) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!existsSync(join(root, '.git'))) { t.skip('no checkout (a packaged build)'); return; }
  let head;
  try { head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { t.skip('no git'); return; }
  const doc = await resolveSigil();
  assert.equal(doc.hash, head);
  assert.ok(passesCoverage(JSON.stringify(doc)));
});
