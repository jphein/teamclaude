import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { publicSettings, saveSettings, SettingsError, MASK } from '../src/settings.js';

// /teamclaude/settings: GET for any authenticated caller (secrets masked),
// POST only for the admin — the shared key, or key-less loopback. A client
// key is handed to every machine in the fleet; the settings it could change
// (upstream, upstreamProxy, the restart command) decide where tokens go and
// what runs, so it may look but not touch.

const SHARED = 'zzSHAREDzz91';
const CLIENT = 'zzCLIENTzz42';
const PROXY = { apiKey: SHARED, clientKeys: [{ name: 'katana', key: CLIENT }] };
const REMOTE = '203.0.113.9';

function makeServer(hooks) {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  return createProxyServer(am, { proxy: PROXY, upstream: 'http://127.0.0.1:9' }, hooks);
}

// Same in-process request driver as ui-remote.test.js: lets a test choose the
// peer address, which a real socket in a test cannot.
function request(server, { method = 'GET', url = '/teamclaude/settings', headers = {}, body = '', from = REMOTE }) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: from } });
  let done;
  const finished = new Promise(r => { done = r; });
  const res = {
    status: null, headers: {}, chunks: '',
    writeHead(status, h) { this.status = status; Object.assign(this.headers, h || {}); return this; },
    write(c) { this.chunks += c; return true; },
    end(c) { if (c) this.chunks += c; done(); },
    on() { return this; },
  };
  server.emit('request', req, res);
  return finished.then(() => ({ status: res.status, body: res.chunks ? JSON.parse(res.chunks) : null }));
}

function spyHooks() {
  const saves = [];
  const config = { proxy: { ...PROXY }, upstream: 'https://api.anthropic.com', accounts: [{ id: 'x', name: 'a', priority: 0, accessToken: 'zzOAUTHzz55' }] };
  return {
    saves,
    hooks: {
      getSettings: async () => publicSettings(config),
      saveSettings: async (changes) => {
        saves.push(changes);
        if (changes.set?.bad) throw new SettingsError(['bad: not a setting']);
        return { applied: ['warmupSeconds'], needsRestart: [], backup: 'teamclaude.json.bak-settings-x' };
      },
    },
  };
}
const SAVE = JSON.stringify({ set: { warmupSeconds: 300 } });

test('GET: a client key may view settings, masked, and is told it cannot edit', async () => {
  const { hooks } = spyHooks();
  const r = await request(makeServer(hooks), { headers: { 'x-api-key': CLIENT } });
  assert.equal(r.status, 200);
  assert.equal(r.body.canEdit, false);
  const raw = JSON.stringify(r.body);
  for (const s of [SHARED, CLIENT, 'zzOAUTHzz55']) assert.ok(!raw.includes(s), `${s} leaked`);
  assert.equal(r.body.fields.find(f => f.key === 'proxy.apiKey').value, MASK);
});

test('GET: the shared key can edit', async () => {
  const { hooks } = spyHooks();
  const r = await request(makeServer(hooks), { headers: { 'x-api-key': SHARED } });
  assert.equal(r.status, 200);
  assert.equal(r.body.canEdit, true);
});

test('GET: no key from another host is refused', async () => {
  const { hooks } = spyHooks();
  assert.equal((await request(makeServer(hooks), {})).status, 401);
});

test('POST: a client key is refused with 403 and nothing is saved', async () => {
  const { hooks, saves } = spyHooks();
  const r = await request(makeServer(hooks), { method: 'POST', headers: { 'x-api-key': CLIENT }, body: SAVE });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /shared proxy key/);
  assert.equal(saves.length, 0);
});

test('POST: the shared key from another host saves', async () => {
  const { hooks, saves } = spyHooks();
  const r = await request(makeServer(hooks), { method: 'POST', headers: { 'x-api-key': SHARED }, body: SAVE });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, applied: ['warmupSeconds'], needsRestart: [], backup: 'teamclaude.json.bak-settings-x' });
  assert.deepEqual(saves, [{ set: { warmupSeconds: 300 } }]);
});

test('POST: key-less loopback (the proxy\'s own host) saves', async () => {
  const { hooks, saves } = spyHooks();
  const r = await request(makeServer(hooks), { method: 'POST', from: '127.0.0.1', headers: { host: '127.0.0.1:3456' }, body: SAVE });
  assert.equal(r.status, 200);
  assert.equal(saves.length, 1);
});

test('POST: loopback with a client key is still only a client', async () => {
  const { hooks, saves } = spyHooks();
  const r = await request(makeServer(hooks), { method: 'POST', from: '127.0.0.1', headers: { host: '127.0.0.1:3456', 'x-api-key': CLIENT }, body: SAVE });
  assert.equal(r.status, 403);
  assert.equal(saves.length, 0);
});

test('POST: a cross-origin page is refused even with the shared key', async () => {
  const { hooks, saves } = spyHooks();
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const r = await request(makeServer(hooks), { method: 'POST', headers: { ...headers, 'x-api-key': SHARED }, body: SAVE });
    assert.equal(r.status, 403);
  }
  assert.equal(saves.length, 0);
});

test('POST: validation problems come back as a 400 list', async () => {
  const { hooks } = spyHooks();
  const r = await request(makeServer(hooks), { method: 'POST', headers: { 'x-api-key': SHARED }, body: JSON.stringify({ set: { bad: 1 } }) });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.problems, ['bad: not a setting']);
});

test('POST: a body that is not JSON is a 400', async () => {
  const { hooks } = spyHooks();
  const r = await request(makeServer(hooks), { method: 'POST', headers: { 'x-api-key': SHARED }, body: '{nope' });
  assert.equal(r.status, 400);
});

// The real save path against a real file: lock → validate → backup → write → reload.
test('saveSettings: backs up the replaced version, writes, reloads; a refused save writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-settings-api-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  const cfg = join(dir, 'teamclaude.json');
  process.env.TEAMCLAUDE_CONFIG = cfg;
  try {
    const original = { proxy: { port: 3456, apiKey: SHARED }, accounts: [{ id: 'a1', name: 'one', priority: 0, accessToken: 't' }, { id: 'a2', name: 'two', priority: 1 }] };
    await writeFile(cfg, JSON.stringify(original), { mode: 0o600 });
    let reloads = 0;
    const r = await saveSettings({ set: { warmupSeconds: 300, 'proxy.port': 3457, 'proxy.apiKey': MASK }, order: ['a2', 'a1'] }, async () => { reloads++; });
    assert.deepEqual(r.applied.sort(), ['accounts.priority', 'warmupSeconds']);
    assert.deepEqual(r.needsRestart, ['proxy.port']);
    assert.equal(reloads, 1);
    const disk = JSON.parse(await readFile(cfg, 'utf8'));
    assert.equal(disk.warmupSeconds, 300);
    assert.equal(disk.proxy.port, 3457);
    assert.equal(disk.proxy.apiKey, SHARED, 'masked key kept');
    assert.equal(disk.accounts[0].accessToken, 't', 'tokens untouched');
    assert.deepEqual(disk.accounts.map(a => [a.name, a.priority]), [['one', 1], ['two', 0]]);
    const bak = join(dir, r.backup);
    assert.equal((await stat(bak)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(bak, 'utf8')).proxy.port, 3456, 'backup is the version replaced');

    await assert.rejects(saveSettings({ set: { 'proxy.port': 0 } }, async () => { reloads++; }), SettingsError);
    assert.equal(JSON.parse(await readFile(cfg, 'utf8')).proxy.port, 3457, 'refused save wrote nothing');
    assert.equal(reloads, 1, 'refused save did not reload');
    const noop = await saveSettings({ set: { warmupSeconds: 300 } }, async () => { reloads++; });
    assert.equal(noop.backup, null, 'no change, no backup');
    assert.equal((await readdir(dir)).filter(f => f.includes('.bak-settings-')).length, 1);
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG; else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

// Oracle (PR #21 review): with NO key configured, auth.ok is true for every
// caller and the key-less block (cross-origin + Host checks) never runs. A
// DNS-rebinding page — loopback-sourced, "same-origin", Host = its own name —
// must still not become admin: it could save accounts[].upstream and receive
// OAuth tokens.
test('POST: with no keys configured, a rebinding page is refused', async () => {
  const { hooks, saves } = spyHooks();
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const open = createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:9' }, hooks);
  const rebind = { host: 'attacker.example', 'sec-fetch-site': 'same-origin' };
  const post = await request(open, { method: 'POST', from: '127.0.0.1', headers: rebind, body: SAVE });
  assert.equal(post.status, 403);
  const get = await request(open, { from: '127.0.0.1', headers: rebind });
  assert.equal(get.body?.canEdit, false);
  // A caller on another host is not admin either, with no key to prove itself.
  assert.equal((await request(open, { method: 'POST', from: REMOTE, headers: { host: '10.0.6.145:3456' }, body: SAVE })).status, 403);
  assert.equal(saves.length, 0);
  // The proxy's own host, naming itself, still is.
  const local = await request(open, { method: 'POST', from: '127.0.0.1', headers: { host: 'localhost:3456' }, body: SAVE });
  assert.equal(local.status, 200);
  assert.equal(saves.length, 1);
});

test('POST: a body over 1 MiB is refused', async () => {
  const { hooks, saves } = spyHooks();
  const r = await request(makeServer(hooks), { method: 'POST', headers: { 'x-api-key': SHARED }, body: JSON.stringify({ set: { blockedModels: ['x'.repeat(1.1 * 1024 * 1024)] } }) });
  assert.equal(r.status, 400);
  assert.equal(saves.length, 0);
});
