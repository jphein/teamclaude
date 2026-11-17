import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { resolveSigil } from '../src/version-sigil.js';

// GET /api/version (realm-sigil; CHECK sigil-coverage, realmwatch #493, JP 2026-11-17 05:07).

const KEY = 'test-client-key';
const PROXY = { apiKey: 'test-shared-key', clientKeys: [{ name: 'browser', key: KEY }] };
const REMOTE = '203.0.113.9';
const DOC = { name: 'teamclaude', description: 'TeamClaude proxy', realm: 'fantasy', repo: 'https://github.com/jphein/teamclaude',
  version: 'Radiant Relic · 3d21c19', hash: '3d21c19', commit_url: 'https://github.com/jphein/teamclaude/commit/3d21c19' };

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
  const doc = await resolveSigil({ root, exec: async (f, a, o) => { calls.push([f, a, o.cwd]); return { stdout: '3d21c19\n' }; } });
  rmSync(root, { recursive: true });
  assert.deepEqual(doc, DOC);
  assert.deepEqual(calls, [['git', ['rev-parse', '--short=7', 'HEAD'], root]]);
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
