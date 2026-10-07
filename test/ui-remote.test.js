import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { injectUiHelpers, uiCsp, dashboardCsp, renderDashboardHtml, withKey, sseFrames, KEY_STORAGE } from '../src/dashboard.js';

// /ui from another machine (2026-10-07). The page is a static asset served
// before the key gate, like /teamclaude/dashboard; everything it shows or
// changes goes through /teamclaude/* behind the gate, with the key the page
// keeps in localStorage sent as x-api-key. Loopback stays key-exempt, and a
// reverse proxy (Caddy on another host, or on this one) gets no exemption.

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI = join(__dirname, '..', 'src', 'web', 'index.html');

const KEY = 'test-client-key';
const PROXY = { apiKey: 'test-shared-key', clientKeys: [{ name: 'browser', key: KEY }] };
const REMOTE = '203.0.113.9';
const CADDY = '10.0.6.50';

function makeServer(hooks = {}, proxy = PROXY) {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k1' },
    { name: 'b', type: 'apikey', apiKey: 'k2' },
  ], 0.98);
  const server = createProxyServer(am, { proxy, upstream: 'http://127.0.0.1:9' }, hooks);
  return { am, server };
}

// A request from an arbitrary peer address, emitted straight into the server:
// a real socket in a test can only come from loopback. Resolves on end(), or
// once an event stream has answered (it stays open), then closes the request.
function request(server, { method = 'GET', url, headers = {}, body = '', from = REMOTE }) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: from } });
  let done;
  const finished = new Promise(r => { done = r; });
  const res = {
    status: null, headers: {}, chunks: '', writableEnded: false,
    writeHead(status, h) {
      this.status = status; Object.assign(this.headers, h || {});
      // An event stream with nothing to replay writes only its head.
      if (/event-stream/.test(this.headers['Content-Type'] || '')) done();
      return this;
    },
    write(c) { this.chunks += c; done(); return true; },
    end(c) { if (c) this.chunks += c; this.writableEnded = true; done(); },
    on() { return this; },
  };
  server.emit('request', req, res);
  return finished.then(() => { req.emit('close'); return res; });
}

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

function spies() {
  const calls = [];
  const hooks = {
    reload: async () => { calls.push('reload'); return 0; },
    persistThreshold: () => { calls.push('threshold'); },
    persistAccountDisabled: () => { calls.push('account'); },
    probeQuota: async () => { calls.push('probe'); },
    reauth: {
      start: async () => { calls.push('reauth'); return { authUrl: 'https://example.invalid/auth' }; },
      submitCode: async () => { calls.push('reauth/code'); return { state: 'pending' }; },
      cancel: () => { calls.push('reauth/cancel'); },
      status: () => ({ state: 'idle' }),
    },
  };
  return { calls, hooks };
}

// Every state-changing endpoint /ui calls, with a body that would succeed.
const MUTATIONS = [
  ['/teamclaude/switch', { account: 'b' }],
  ['/teamclaude/threshold', { value: 0.5 }],
  ['/teamclaude/account', { name: 'a', disabled: true }],
  ['/teamclaude/reauth', { name: 'a' }],
  ['/teamclaude/reauth/code', { code: 'x' }],
  ['/teamclaude/reauth/cancel', undefined],
  ['/teamclaude/restart', undefined],
  ['/teamclaude/probe', undefined],
  ['/teamclaude/reload', undefined],
];
const JSON_HEADERS = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

// ── The page asset ────────────────────────────────────────────

test('remote GET /ui is served without a key, with the dashboard\'s headers', async () => {
  const { server } = makeServer();
  for (const url of ['/ui', '/ui/', '/ui/index.html']) {
    const res = await request(server, { url });
    assert.equal(res.status, 200, url);
    assert.match(res.headers['Content-Type'], /text\/html/);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(res.chunks, /id="keybox"/);
    assert.equal(res.headers['Content-Security-Policy'], uiCsp(res.chunks));
  }
});

test('/ui\'s policy admits exactly its own inline scripts, and loosens the baseline by img-src data: only', async () => {
  const html = injectUiHelpers(await readFile(UI, 'utf8'));
  const csp = uiCsp(html);
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(blocks.length, 2, 'helpers block + page block');
  const scriptSrc = csp.split('; ').find(d => d.startsWith('script-src '));
  assert.deepEqual(scriptSrc.slice('script-src '.length).split(' ').sort(),
    blocks.map(b => `'sha256-${createHash('sha256').update(b, 'utf8').digest('base64')}'`).sort());
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(scriptSrc, /unsafe-inline/);
  for (const d of ["default-src 'none'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.split('; ').includes(d), d);
  }
  // The only difference from the dashboard's policy is the favicon allowance.
  const strip = (p) => p.split('; ').filter(d => !d.startsWith('script-src ')).join('; ');
  assert.equal(strip(csp).replace("; img-src data:", ''), strip(dashboardCsp()));
  // The dashboard's own policy is unchanged by the generalisation: one hash.
  assert.equal(dashboardCsp().match(/'sha256-/g).length, 1);
  // Nothing on the page loads from elsewhere, so connect/img/script need no host.
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i);
});

test('only GET reaches the pre-gate /ui handler', async () => {
  const { server } = makeServer();
  assert.equal((await request(server, { method: 'POST', url: '/ui' })).status, 401);
  assert.equal((await request(server, { url: '/ui?x=1' })).status, 401, 'exact paths only');
});

// ── The data and control endpoints behind it ──────────────────

test('remote reads need the key: none or wrong → 401, client or shared key → 200', async () => {
  const { server } = makeServer();
  for (const url of ['/teamclaude/status', '/teamclaude/quota', '/teamclaude/reauth', '/teamclaude/activity', '/teamclaude/logs']) {
    assert.equal((await request(server, { url })).status, 401, url + ' keyless');
    assert.equal((await request(server, { url, headers: { 'x-api-key': 'wrong' } })).status, 401, url + ' wrong key');
  }
  for (const key of [KEY, PROXY.apiKey]) {
    const res = await request(server, { url: '/teamclaude/status', headers: { 'x-api-key': key } });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.chunks).accounts.length, 2);
  }
  const { hooks } = spies();
  const withReauth = makeServer(hooks).server;
  assert.equal((await request(withReauth, { url: '/teamclaude/reauth', headers: { 'x-api-key': KEY } })).status, 200);
  // The activity stream is what /ui reads with fetch + header now.
  const sse = await request(server, { url: '/teamclaude/activity', headers: { 'x-api-key': KEY } });
  assert.equal(sse.status, 200);
  assert.match(sse.headers['Content-Type'], /text\/event-stream/);
});

test('every mutating endpoint /ui calls refuses a keyless remote caller, with no side effect', async () => {
  const { calls, hooks } = spies();
  const { server, am } = makeServer(hooks);
  for (const [url, body] of MUTATIONS) {
    const res = await request(server, { method: 'POST', url, headers: JSON_HEADERS, body: body ? JSON.stringify(body) : '' });
    assert.equal(res.status, 401, url);
    const wrong = await request(server, { method: 'POST', url, headers: { ...JSON_HEADERS, 'x-api-key': 'wrong' }, body: body ? JSON.stringify(body) : '' });
    assert.equal(wrong.status, 401, url + ' wrong key');
  }
  assert.deepEqual(calls, []);
  assert.equal(am.currentIndex, 0);
  assert.equal(am.switchThreshold, 0.98);
  assert.equal(!!am.accounts[0].disabled, false);
});

test('a remote caller with the key reaches each mutating endpoint (restart excluded: it would run systemctl)', async () => {
  const { calls, hooks } = spies();
  const { server, am } = makeServer(hooks);
  for (const [url, body] of MUTATIONS.filter(([u]) => u !== '/teamclaude/restart')) {
    const res = await request(server, { method: 'POST', url, headers: { ...JSON_HEADERS, 'x-api-key': KEY }, body: body ? JSON.stringify(body) : '' });
    assert.equal(res.status, 200, url + ' ' + res.chunks);
  }
  assert.deepEqual(calls.sort(), ['account', 'probe', 'reauth', 'reauth/cancel', 'reauth/code', 'reload', 'threshold']);
  assert.equal(am.currentIndex, 1);
});

test('a page on another origin holding no key gets nothing; even with the key, a cross-site POST is refused', async () => {
  const { calls, hooks } = spies();
  const { server } = makeServer(hooks);
  for (const [url, body] of MUTATIONS) {
    // The no-cors / text/plain "simple request" a hostile page can send.
    const res = await request(server, {
      method: 'POST', url, body: body ? JSON.stringify(body) : '',
      headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', 'x-api-key': KEY },
    });
    assert.equal(res.status, 403, url);
  }
  assert.deepEqual(calls, []);
});

// ── Loopback unchanged ────────────────────────────────────────

test('loopback is unchanged: page, reads and controls work with no key', async () => {
  const { calls, hooks } = spies();
  const { server, am } = makeServer(hooks);
  const port = await listen(server);
  try {
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/ui`);
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy'));
    assert.equal((await fetch(`${base}/teamclaude/status`)).status, 200);
    const thr = await fetch(`${base}/teamclaude/threshold`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 0.7 }) });
    assert.equal(thr.status, 200);
    assert.equal(am.switchThreshold, 0.7);
    assert.deepEqual(calls, ['threshold']);
  } finally { server.close(); }
});

// ── Behind a reverse proxy (Caddy → :3456) ────────────────────

test('behind a reverse proxy the page loads but the key is required, wherever the proxy runs', async () => {
  const { calls, hooks } = spies();
  const { server, am } = makeServer(hooks);
  const fwd = { 'x-forwarded-for': '198.51.100.4', 'x-forwarded-proto': 'https', host: 'tc.example.test' };
  // Caddy on another host: the peer is Caddy's address. Caddy on this host:
  // the peer is loopback, and the forwarding header refuses the exemption.
  // A forwarded-for that claims loopback buys nothing either: the header is
  // never read as an identity, only as "someone forwarded this".
  for (const [from, extra] of [[CADDY, {}], ['127.0.0.1', {}], ['::1', {}], [CADDY, { 'x-forwarded-for': '127.0.0.1' }], ['127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }]]) {
    const headers = { ...fwd, ...extra };
    const label = `${from} xff=${headers['x-forwarded-for']}`;
    assert.equal((await request(server, { url: '/ui', headers, from })).status, 200, label);
    assert.equal((await request(server, { url: '/teamclaude/status', headers, from })).status, 401, label);
    assert.equal((await request(server, { url: '/teamclaude/activity', headers, from })).status, 401, label);
    assert.equal((await request(server, { method: 'POST', url: '/teamclaude/switch', headers: { ...headers, ...JSON_HEADERS }, body: '{"account":"b"}', from })).status, 401, label);
    assert.equal((await request(server, { url: '/teamclaude/status', headers: { ...headers, 'x-api-key': KEY }, from })).status, 200, label);
  }
  // `Forwarded` and `X-Real-IP` alone mark a request just the same.
  for (const h of [{ forwarded: 'for=198.51.100.4' }, { 'x-real-ip': '198.51.100.4' }]) {
    assert.equal((await request(server, { url: '/teamclaude/status', headers: h, from: '127.0.0.1' })).status, 401, Object.keys(h)[0]);
  }
  assert.deepEqual(calls, []);
  assert.equal(am.currentIndex, 0);
});

// ── The page's own script ─────────────────────────────────────

test('withKey adds the key as a header (never to the URL) and leaves the caller\'s init alone', () => {
  const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
  const out = withKey(init, 'k');
  assert.deepEqual(out, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' } });
  assert.deepEqual(init.headers, { 'content-type': 'application/json' }, 'not mutated');
  assert.deepEqual(withKey(undefined, ''), { headers: {} }, 'no key, no header');
  assert.deepEqual(withKey({ cache: 'no-store' }, null), { cache: 'no-store', headers: {} });
});

test('sseFrames parses complete events and keeps the partial tail', () => {
  assert.deepEqual(sseFrames('data: {"a":1}\n\ndata: {"b"'), { events: ['{"a":1}'], rest: 'data: {"b"' });
  assert.deepEqual(sseFrames('data: x\r\n\r\n: comment\n\ndata:y\ndata: z\n\n'), { events: ['x', 'y\nz'], rest: '' });
  assert.deepEqual(sseFrames(''), { events: [], rest: '' });
  // Fed in arbitrary chunks, the stream yields the same events as in one piece.
  const whole = 'data: "one"\n\ndata: "two"\n\ndata: "three"\n\n';
  let buf = ''; const got = [];
  for (let i = 0; i < whole.length; i += 3) {
    const p = sseFrames(buf + whole.slice(i, i + 3));
    buf = p.rest; got.push(...p.events);
  }
  assert.deepEqual(got, ['"one"', '"two"', '"three"']);
});

test('the /ui script sends no key on loopback, prompts on 401, then sends the key on every call', async () => {
  const html = injectUiHelpers(await readFile(UI, 'utf8'));
  // The page never builds a URL with a key in it, and has no EventSource left.
  assert.doesNotMatch(html, /new EventSource/);
  assert.doesNotMatch(html, /[?&](api_?key|key|token)=/i);
  // Every network call in the page script goes through api() (one raw fetch: api's own).
  const pageScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  assert.equal(pageScript.match(/\bfetch\(/g).length, 1);
  assert.match(pageScript, /await fetch\(path, withKey\(init, storedKey\(\)\)\)/);

  const elements = new Map();
  const makeEl = (id) => {
    const handlers = {};
    const node = {
      id, style: {}, value: '', textContent: '', children: [], dataset: {}, disabled: false,
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      fire(type, ev = {}) { for (const fn of handlers[type] || []) fn(ev); },
      appendChild(c) { node.children.push(c); return c; },
      append() {}, insertBefore(c) { return c; }, removeChild() {}, setAttribute() {}, getAttribute() { return null; },
      focus() {}, closest() { return null; },
    };
    return node;
  };
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
    createElement(tag) { return makeEl(tag); },
    createTextNode(t) { return { textContent: t }; },
    activeElement: null,
  };
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const fetches = [];
  let answer = 401;
  const fetchStub = (url, init) => {
    fetches.push({ url, key: init?.headers?.['x-api-key'] ?? null });
    if (answer === 401) return Promise.resolve({ status: 401, ok: false, json: async () => ({}), body: null });
    return new Promise(() => {}); // after unlock: leave every call pending
  };
  const ctx = vm.createContext({
    document, localStorage, fetch: fetchStub, window: { open: () => null },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    AbortController, TextDecoder, console, Date, Math, JSON, Map, Set, Promise, Error, Number, String, Object, Array, RegExp,
  });
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  for (const b of blocks) vm.runInContext(b, ctx);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
  await settle();

  // Boot: status + both streams, all keyless (a loopback page needs none).
  const boot = fetches.splice(0);
  assert.deepEqual(boot.map(f => f.url).sort(), ['/teamclaude/activity', '/teamclaude/logs', '/teamclaude/status']);
  assert.ok(boot.every(f => f.key === null), 'no key stored → no header');
  // The 401 brought up the prompt and hid the app.
  assert.equal(elements.get('keybox').style.display, 'block');
  assert.equal(elements.get('app').style.display, 'none');

  // Unlock: the key is stored in the shared slot and rides on every call.
  answer = 200;
  elements.get('keyInput').value = '  the-key  ';
  elements.get('keyGo').fire('click');
  await settle();
  assert.equal(store.get(KEY_STORAGE), 'the-key');
  assert.equal(elements.get('keybox').style.display, 'none');
  const after = fetches.splice(0);
  assert.deepEqual(after.map(f => f.url).sort(), ['/teamclaude/activity', '/teamclaude/logs', '/teamclaude/status']);
  assert.ok(after.every(f => f.key === 'the-key'), JSON.stringify(after));
  // A control action carries it too.
  elements.get('probeBtn').fire('click');
  await settle();
  assert.deepEqual(fetches.splice(0), [{ url: '/teamclaude/probe', key: 'the-key' }]);
});

test('both dashboards keep the key in the same localStorage slot', () => {
  assert.match(renderDashboardHtml(), new RegExp(`var KEY = ${JSON.stringify(KEY_STORAGE)};`));
});
