// The dashboard's account cards used to show only the shared 5h/7d buckets.
// Fable and Sonnet meter their OWN weekly quota, and selection skips an account
// whose family bucket is spent — so an account could read "95%, active" on the
// card while every Fable request bounced off it (2026-08-20: claude2 was at
// unified7d 0.95 but unified7dFable 1.0, and the card gave no hint why the
// manual switch would not stick). These tests pin the family-bucket readout.
//
// The dashboard is a single self-contained HTML page with inline JS and the
// package carries no DOM/test-browser dependency, so we lift the pure helper
// `familyBuckets()` out of the page source and exercise it in a vm sandbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, '..', 'src', 'web', 'index.html');

/** Extract `function familyBuckets(...) { ... }` from the page and compile it. */
async function loadFamilyBuckets() {
  const html = await readFile(HTML_PATH, 'utf-8');
  const start = html.indexOf('function familyBuckets(');
  assert.notEqual(start, -1, 'familyBuckets() not found in the dashboard source');
  // Walk braces from the function's opening brace to its match.
  let i = html.indexOf('{', start), depth = 0, end = -1;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  assert.notEqual(end, -1, 'familyBuckets() body is unbalanced');
  const ctx = { result: null };
  vm.createContext(ctx);
  vm.runInContext(`${html.slice(start, end)}; result = familyBuckets;`, ctx);
  // Values built inside the sandbox carry the sandbox's prototypes, which
  // deepStrictEqual treats as unequal to structurally identical host values —
  // round-trip through JSON so assertions compare plain data.
  return (q) => JSON.parse(JSON.stringify(ctx.result(q)));
}

test('familyBuckets surfaces a spent Fable weekly bucket with its own reset', async () => {
  const familyBuckets = await loadFamilyBuckets();
  // claude2's real shape on 2026-08-20: unified weekly under threshold, Fable spent.
  const bars = familyBuckets({
    unified5h: 0.65,
    unified7d: 0.95,
    unified7dReset: 1787288400000,
    unified7dFable: 1,
    unified7dFableReset: 1787288399939,
    unified7dSonnet: null,
    unified7dSonnetReset: null,
  });
  assert.equal(bars.length, 1);
  assert.equal(bars[0].label, '7d fable');
  assert.equal(bars[0].util, 1);
  assert.equal(bars[0].reset, 1787288399939);
});

test('familyBuckets lists Fable and Sonnet together when both are reported', async () => {
  const familyBuckets = await loadFamilyBuckets();
  const bars = familyBuckets({
    unified7d: 0.4,
    unified7dFable: 0.5,
    unified7dFableReset: 111,
    unified7dSonnet: 0.25,
    unified7dSonnetReset: 222,
  });
  assert.deepEqual(bars.map(b => b.label), ['7d fable', '7d sonnet']);
  assert.deepEqual(bars.map(b => b.util), [0.5, 0.25]);
});

test('familyBuckets stays empty when no family bucket is reported', async () => {
  const familyBuckets = await loadFamilyBuckets();
  assert.deepEqual(familyBuckets({ unified5h: 0.1, unified7d: 0.2 }), []);
  assert.deepEqual(familyBuckets({}), []);
  assert.deepEqual(familyBuckets(null), []);
});

test('GET /teamclaude/status keeps the family buckets the card renders', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { createProxyServer } = await import('../src/server.js');
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.99);
  am.accounts[0].quota.unified7d = 0.95;
  am.accounts[0].quota.unified7dFable = 1;
  am.accounts[0].quota.unified7dFableReset = 1787288399939;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  try {
    const status = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json();
    const quota = status.accounts[0].quota;
    assert.equal(quota.unified7dFable, 1);
    assert.equal(quota.unified7dFableReset, 1787288399939);
  } finally { proxy.close(); }
});
