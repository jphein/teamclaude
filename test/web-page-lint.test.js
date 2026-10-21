// The dashboard is one self-contained HTML page whose inline <script> never
// passes through the repo's eslint run (that only sees .js files). On
// 2026-10-21 a variable used after its for-of loop had ended reached the live
// page as "Cannot reach proxy: fb is not defined": the status renderer threw a
// ReferenceError on every poll, and the catch reported it as a network failure.
// This lints every inline script with no-undef, so a name that does not exist
// at its use fails CI instead of the user's dashboard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Linter } from 'eslint';
import { injectUiHelpers } from '../src/dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, '..', 'src', 'web', 'index.html');

// The browser globals the page actually uses. A name missing here fails the
// test: add it only if it is a real browser global.
const BROWSER = [
  'window', 'document', 'console', 'fetch', 'localStorage', 'sessionStorage', 'location', 'navigator',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'URL', 'URLSearchParams', 'AbortController', 'EventSource', 'Intl', 'matchMedia', 'getComputedStyle',
  'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver', 'ResizeObserver', 'Blob', 'FormData',
  'TextDecoder', 'TextEncoder', 'atob', 'btoa', 'alert', 'confirm', 'performance', 'crypto', 'structuredClone',
  'queueMicrotask', 'history', 'screen', 'innerWidth', 'innerHeight', 'Headers', 'Response', 'Request',
];

/** Every inline <script> body (not src= ones), with the line it starts on. */
function inlineScripts(html) {
  const out = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/.test(m[1] || '')) continue;
    const line = html.slice(0, m.index).split('\n').length;
    out.push({ code: m[2], line });
  }
  return out;
}

test('every inline script on the dashboard page, as served, passes no-undef', async () => {
  // As served: the server injects the shared helpers (src/dashboard.js) into the
  // first script. Classic scripts share one global scope, so they are linted as
  // one program, in page order.
  const html = injectUiHelpers(await readFile(HTML_PATH, 'utf-8'));
  const scripts = inlineScripts(html);
  assert.ok(scripts.length > 1, 'expected the helpers script and the page script — did the page move?');
  const code = scripts.map((x) => x.code).join('\n;\n');
  const messages = new Linter().verify(code, {
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: Object.fromEntries(BROWSER.map((g) => [g, 'readonly'])) },
    rules: { 'no-undef': 'error' },
  });
  const lines = code.split('\n');
  const problems = messages.map((m) => `${m.message} — near: ${(lines[m.line - 1] || '').trim().slice(0, 100)}`);
  assert.deepEqual(problems, [], problems.join('\n'));
});
