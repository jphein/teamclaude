import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { sharedHelpersScript, injectUiHelpers, UI_HELPERS_PLACEHOLDER, routeRows, problems } from '../src/dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI = join(__dirname, '..', 'src', 'web', 'index.html');

// /ui runs the key-gated dashboard's tested helpers instead of its own copies,
// so the two pages cannot drift apart again (2026-10-02: /ui lacked routing,
// problems, block reasons and the session/client tables).

test('the shared helper script defines every helper /ui calls, and they agree with the module', () => {
  const ctx = vm.createContext({});
  vm.runInContext(sharedHelpersScript(), ctx);
  for (const fn of ['routeRows', 'problems', 'sessionRows', 'filterSessionRows', 'sortRows', 'uniqSorted', 'accountTokens', 'providerLabel']) {
    assert.equal(typeof ctx[fn], 'function', fn);
  }
  assert.equal(typeof ctx.UNAVAILABLE_TEXT, 'object');
  const status = {
    currentAccount: 'a', accounts: [{ name: 'a', unavailable: 'quota' }, { name: 'b', unavailable: 'quota' }],
    routes: [{ name: 'fable', match: ['*fable*'], target: 'b', accounts: [{ name: 'a', eligible: false }, { name: 'b', eligible: true }] }],
    sessions: { active: 2 },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.routeRows(status))), routeRows(status));
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.problems(status))), problems(status));
});

test('the /ui source carries the placeholder exactly once, and injection consumes it', async () => {
  const raw = await readFile(UI, 'utf8');
  assert.equal(raw.split(UI_HELPERS_PLACEHOLDER).length, 2, 'one marker in src/web/index.html');
  const html = injectUiHelpers(raw);
  assert.ok(!html.includes(UI_HELPERS_PLACEHOLDER));
  assert.ok(html.includes('function routeRows('));
  // Every inline script of the served page parses.
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
});

test('GET /ui serves the page with the shared helpers injected', async () => {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc' }, upstream: 'http://127.0.0.1:9' });
  const port = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/ui`)).text();
    assert.ok(html.includes('function problems('), 'helpers injected');
    assert.ok(!html.includes(UI_HELPERS_PLACEHOLDER), 'marker consumed');
    for (const id of ['problems', 'routes', 'clients', 'sessions', 'fleetLine']) assert.match(html, new RegExp(`id="${id}"`));
  } finally { proxy.close(); }
});
