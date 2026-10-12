import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rotationView, orderControls, EXPIRY_RULE, PRIORITY_RULE, sharedHelpersScript } from '../src/dashboard.js';

// JP, 2026-10-11 19:5x: "the one that expires first is the one that is being
// used". With expiry routing on, the order traffic follows is live pressure,
// and the priority arrows would only pretend to reorder — so the page shows
// pressure order and hides them. With it off, strict list order and arrows.

const PER_MS = 1 / 3_600_000; // pressure arrives per ms; the page shows per hour
const live = (expiry) => ({
  expiryRouting: { enabled: expiry, tolerance: 1.2, preempt: true },
  accounts: [
    { name: 'claude3', priority: 0, status: 'active', pressure: 0.0025 * PER_MS },
    { name: 'jp', priority: 1, status: 'active', pressure: 0.0035 * PER_MS },
    { name: 'claude', priority: 2, status: 'active', pressure: 0.0026 * PER_MS },
    { name: 'claude2', priority: 3, status: 'active', pressure: 0 },          // weekly spent
    { name: 'claude4', priority: 4, status: 'active', pressure: 0.0058 * PER_MS },
  ],
});

test('expiry on: accounts in live pressure order, spent last, with per-hour pressure', () => {
  const v = rotationView(live(true));
  assert.equal(v.mode, 'expiry');
  assert.equal(v.rule, EXPIRY_RULE);
  assert.deepEqual(v.accounts.map(x => x.account.name), ['claude4', 'jp', 'claude', 'claude3', 'claude2']);
  assert.ok(Math.abs(v.accounts[0].pressurePerHour - 0.0058) < 1e-12);
  assert.equal(v.accounts.at(-1).serves, false);
});

test('expiry off: strict priority order, the pressure ignored', () => {
  const v = rotationView(live(false));
  assert.equal(v.mode, 'priority');
  assert.equal(v.rule, PRIORITY_RULE);
  assert.deepEqual(v.accounts.map(x => x.account.name), ['claude3', 'jp', 'claude', 'claude2', 'claude4']);
});

test('expiry on: disabled and errored accounts sort after every serving one', () => {
  const s = live(true);
  s.accounts[4].disabled = true;           // claude4, the highest pressure
  s.accounts[1].status = 'error';          // jp
  assert.deepEqual(rotationView(s).accounts.map(x => x.account.name), ['claude', 'claude3', 'claude4', 'jp', 'claude2']);
});

test('arrows vs expiry: hidden with a one-line reason while expiry routing is on', () => {
  const on = orderControls({ enabled: true, tolerance: 1.2 });
  assert.equal(on.arrows, false);
  assert.match(on.note, /^Expiry routing is on/);
  assert.ok(!on.note.includes('\n'));
  for (const off of [undefined, null, {}, { enabled: false }, { enabled: 'true' }]) {
    assert.deepEqual(orderControls(off), { arrows: true, note: null }, JSON.stringify(off));
  }
});

test('the rule lines carry JP\'s wording', () => {
  assert.match(EXPIRY_RULE, /resets soonest \(most to lose first\); skips any whose 5-hour window is full; re-ranks for each new session; running sessions stay put unless their account runs out or renews\./);
  assert.match(PRIORITY_RULE, /highest account with quota left; when a higher one renews, traffic moves back to it/);
});

test('the page gets the helpers and uses them for cards, arrows and save', async () => {
  const script = sharedHelpersScript();
  for (const name of ['function rotationView', 'function orderControls', 'var EXPIRY_RULE', 'var PRIORITY_RULE']) assert.ok(script.includes(name), name);
  const html = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'index.html'), 'utf8');
  assert.match(html, /const view = rotationView\(data\);/, 'cards follow rotationView');
  assert.match(html, /const ctl = orderControls\(/, 'Settings asks orderControls about the arrows');
  // Saving while the list shows pressure order must not send an order, which
  // would rewrite every priority behind the operator's back.
  assert.match(html, /const order = arrowsOn && /, 'save sends an order only when the arrows are on');
});
