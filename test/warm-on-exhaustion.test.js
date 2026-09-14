import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Warmer } from '../src/warmer.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function fakeSpawner() {
  const calls = [];
  const fn = async (spec) => { calls.push(spec); return 0; };
  fn.calls = calls;
  return fn;
}

// Upstream headers reporting the shared 5h bucket at `utilization`, resetting at `resetMs`.
function headers5h(utilization, resetMs) {
  return {
    'anthropic-ratelimit-unified-5h-utilization': String(utilization),
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(resetMs / 1000)),
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// ── AccountManager: the 5h-exhausted event ───────────────────────────────────

test('crossing the switch threshold on the 5h bucket fires on5hExhausted once per window', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const fired = [];
  am.on5hExhausted(ev => fired.push(ev));
  const reset = Date.now() + 3600_000;

  am.updateQuota(0, headers5h(0.5, reset));
  assert.equal(fired.length, 0, 'below threshold: nothing');

  am.updateQuota(0, headers5h(0.99, reset));
  assert.equal(fired.length, 1, 'crossing fires');
  assert.equal(fired[0].account.name, 'a');

  am.updateQuota(0, headers5h(1, reset));
  am.updateQuota(0, headers5h(1, reset + 500)); // same window, header jitter
  assert.equal(fired.length, 1, 'staying exhausted in the same window does not re-fire');

  am.updateQuota(0, headers5h(0.99, reset + 5 * 3600_000));
  assert.equal(fired.length, 2, 'a later window exhausting fires again');
});

test('the usage-endpoint probe path fires the event too', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  let fired = 0;
  am.on5hExhausted(() => fired++);
  am.applyUsageData(0, { fiveHour: { utilization: 0.985, resetAt: Date.now() + 3600_000 } });
  assert.equal(fired, 1);
});

test('a listener that throws does not break quota accounting', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.on5hExhausted(() => { throw new Error('boom'); });
  am.updateQuota(0, headers5h(1, Date.now() + 3600_000));
  assert.equal(am.accounts[0].quota.unified5h, 1);
});

// ── Warmer: warm every cold account when one exhausts its 5h window ──────────

test('with onExhaustion on, an exhausted account triggers a warm sweep of the cold accounts', async () => {
  const am = new AccountManager([oauth('hot'), oauth('cold1'), oauth('cold2'), oauth('warm')], 0.98);
  am.accounts[3].quota.unified5hReset = Date.now() + 3600_000; // window already running
  const spawn = fakeSpawner();
  const warmer = new Warmer(am, { intervalMs: 0, onExhaustion: true, transport: 'claude', port: 3456, apiKey: 'k', spawnFn: spawn, log: () => {} });
  warmer.start();

  am.updateQuota(0, headers5h(1, Date.now() + 3600_000));
  await tick(); await tick();

  const pinned = spawn.calls.map(c => c.env.ANTHROPIC_BASE_URL.split('/tc-acct/')[1]).sort();
  assert.deepEqual(pinned, ['cold1', 'cold2'], 'only the cold accounts are warmed — not the exhausted one, not the running one');
  assert.equal(warmer.getStatus().enabled, true);
  assert.equal(warmer.getStatus().onExhaustion, true);
  assert.equal(warmer.getStatus().lastTrigger, 'exhaustion:hot');
  warmer.stop();
});

test('with onExhaustion off (the default), exhaustion warms nothing', async () => {
  const am = new AccountManager([oauth('hot'), oauth('cold')], 0.98);
  const spawn = fakeSpawner();
  const warmer = new Warmer(am, { intervalMs: 0, transport: 'claude', port: 3456, apiKey: 'k', spawnFn: spawn, log: () => {} });
  warmer.start();
  am.updateQuota(0, headers5h(1, Date.now() + 3600_000));
  await tick(); await tick();
  assert.equal(spawn.calls.length, 0);
  assert.equal(warmer.getStatus().enabled, false);
});

test('setOnExhaustion toggles live without a restart', async () => {
  const am = new AccountManager([oauth('hot'), oauth('cold')], 0.98);
  const spawn = fakeSpawner();
  const warmer = new Warmer(am, { intervalMs: 0, transport: 'claude', port: 3456, apiKey: 'k', spawnFn: spawn, log: () => {} });
  warmer.start();
  warmer.setOnExhaustion(true);
  am.updateQuota(0, headers5h(1, Date.now() + 3600_000));
  await tick(); await tick();
  assert.equal(spawn.calls.length, 1);

  warmer.setOnExhaustion(false);
  am.updateQuota(1, headers5h(1, Date.now() + 3600_000));
  await tick(); await tick();
  assert.equal(spawn.calls.length, 1, 'no sweep once turned off');
  assert.equal(warmer.getStatus().enabled, false);
});

test('a stopped warmer ignores exhaustion events', async () => {
  const am = new AccountManager([oauth('hot'), oauth('cold')], 0.98);
  const spawn = fakeSpawner();
  const warmer = new Warmer(am, { intervalMs: 0, onExhaustion: true, transport: 'claude', port: 3456, apiKey: 'k', spawnFn: spawn, log: () => {} });
  warmer.start();
  warmer.stop();
  am.updateQuota(0, headers5h(1, Date.now() + 3600_000));
  await tick(); await tick();
  assert.equal(spawn.calls.length, 0);
});

// ── direct transport (the default) ──────────────────────────────────────────

function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (status instanceof Error) throw status;
    return { status, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

test('direct transport POSTs a one-token haiku message to the pinned proxy path', async () => {
  const am = new AccountManager([oauth('cold', { accountUuid: 'uuid-1' })], 0.98);
  const fetch = fakeFetch(200);
  const warmer = new Warmer(am, { intervalMs: 0, port: 4321, apiKey: 'tc-secret', fetchFn: fetch, log: () => {} });
  await warmer.warmAll();

  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'http://127.0.0.1:4321/tc-acct/uuid-1/v1/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], 'tc-secret');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'claude-haiku-4-5-20251001');
  assert.equal(body.max_tokens, 1);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.ok(init.signal instanceof AbortSignal, 'a timeout/abort signal is attached');
  assert.equal(warmer.getStatus().transport, 'direct');
  assert.equal(warmer.getStatus().accounts[0].status, 'ok');
});

test('direct transport records a non-2xx as an error, and a network failure too', async () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  const w1 = new Warmer(am, { intervalMs: 0, port: 1, fetchFn: fakeFetch(429), log: () => {} });
  await w1.warmAll();
  assert.equal(w1.getStatus().accounts[0].status, 'error');
  assert.equal(w1.getStatus().accounts[0].error, 'HTTP 429');

  const w2 = new Warmer(am, { intervalMs: 0, port: 1, fetchFn: fakeFetch(new Error('ECONNREFUSED')), log: () => {} });
  await w2.warmAll();
  assert.equal(w2.getStatus().accounts[1].status, 'error');
  assert.match(w2.getStatus().accounts[1].error, /ECONNREFUSED/);
});

test('an explicit model id passes through; bare aliases map to full ids', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const fetch = fakeFetch(200);
  await new Warmer(am, { intervalMs: 0, port: 1, model: 'claude-sonnet-5', fetchFn: fetch, log: () => {} }).warmAll();
  assert.equal(JSON.parse(fetch.calls[0].init.body).model, 'claude-sonnet-5');
});
