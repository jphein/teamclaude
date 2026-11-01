import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { atomicConfigUpdate } from '../src/config.js';
import { mergeAccountsForSave, removedAccountIds, clearRemovedAccountIds } from '../src/account-pairing.js';

// The dashboard's per-card controls (JP 2026-11-01): an account's own 5h/7d
// rotate-at limits, and Unlink. Both go through POST /teamclaude/account, and
// both are asserted on two halves — the config file and the running fleet.
// TEAMCLAUDE_CONFIG points at a throwaway file throughout.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const ACCTS = () => [
  { id: 'id-a', name: 'a', type: 'apikey', apiKey: 'sk-test-a' },
  { id: 'id-b', name: 'b', type: 'apikey', apiKey: 'sk-test-b' },
];

async function withServer(fn, { accounts = ACCTS(), proxy = { apiKey: 'tc-test' }, hooks: extra = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-acct-limits-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ proxy, upstream: 'https://api.anthropic.com', accounts }));
  const previous = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = path;
  const config = { proxy, upstream: 'https://api.anthropic.com', accounts: accounts.map(a => ({ ...a })) };
  const am = new AccountManager(accounts.map(a => ({ ...a })), 0.98);
  const reloads = { count: 0 };
  const hooks = {
    reload: async () => { reloads.count++; return 0; },
    // What index.js wires: the save writes the merged list, so a removed
    // entry (marked by the endpoint) is left off the file.
    persistAccounts: () => atomicConfigUpdate(disk => {
      disk.accounts = mergeAccountsForSave(config.accounts, am.accounts, disk.accounts, removedAccountIds(config));
      clearRemovedAccountIds(config);
    }),
    ...extra,
  };
  const server = createProxyServer(am, config, hooks);
  const port = await listen(server);
  const disk = async () => JSON.parse(await readFile(path, 'utf-8'));
  try {
    await fn({ port, am, reloads, disk, config });
  } finally {
    server.close();
    if (previous === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = previous;
  }
}

async function post(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teamclaude-control': '1', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Own limits ────────────────────────────────────────────────

test('an account limit for one bucket is saved as a table and applied by a reload', async () => {
  await withServer(async ({ port, reloads, disk }) => {
    const res = await post(port, { name: 'a', threshold: { bucket: 'unified5h', percent: 85 } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.switchThreshold, { unified5h: 0.85 });
    assert.equal(res.body.governedBy, 'account');
    assert.deepEqual((await disk()).accounts[0].switchThreshold, { unified5h: 0.85 });
    assert.equal((await disk()).accounts[1].switchThreshold, undefined, 'only the named account changes');
    assert.equal(reloads.count, 1, 'saving alone would leave the fleet on the old number');
  });
});

test('setting the 7d limit keeps the 5h one, and following the fleet drops only its bucket', async () => {
  await withServer(async ({ port, disk }) => {
    await post(port, { name: 'a', threshold: { bucket: 'unified5h', percent: 85 } });
    await post(port, { name: 'a', threshold: { bucket: 'unified7d', percent: 70 } });
    assert.deepEqual((await disk()).accounts[0].switchThreshold, { unified5h: 0.85, unified7d: 0.7 });
    const res = await post(port, { name: 'a', threshold: { bucket: 'unified5h', percent: null } });
    assert.equal(res.status, 200);
    assert.equal(res.body.governedBy, 'fleet');
    assert.deepEqual((await disk()).accounts[0].switchThreshold, { unified7d: 0.7 });
    await post(port, { name: 'a', threshold: { bucket: 'unified7d', percent: null } });
    assert.equal('switchThreshold' in (await disk()).accounts[0], false, 'nothing left: the field goes');
  });
});

test('a bad bucket or percentage is refused and nothing is written', async () => {
  await withServer(async ({ port, reloads, disk }) => {
    for (const threshold of [{ bucket: 'unified1h', percent: 80 }, { bucket: 'unified5h', percent: 0 }, { bucket: 'unified5h', percent: 'x' }, { bucket: 'unified5h' }, 5]) {
      const res = await post(port, { name: 'a', threshold });
      assert.equal(res.status, 400, JSON.stringify(threshold));
    }
    assert.equal((await disk()).accounts[0].switchThreshold, undefined);
    assert.equal(reloads.count, 0);
  });
});

test('an unknown account is 404 for a limit and for an unlink', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await post(port, { name: 'ghost', threshold: { bucket: 'unified5h', percent: 80 } })).status, 404);
    assert.equal((await post(port, { name: 'ghost', remove: true, confirm: 'ghost' })).status, 404);
  });
});

test('one change per request: two asks in one body are refused', async () => {
  await withServer(async ({ port, am, disk }) => {
    const res = await post(port, { name: 'a', disabled: true, remove: true, confirm: 'a' });
    assert.equal(res.status, 400);
    assert.equal(am.accounts.length, 2);
    assert.equal(am.accounts[0].disabled, false);
    assert.equal((await disk()).accounts.length, 2);
  });
});

test('a client key can neither set a limit nor unlink', async () => {
  await withServer(async ({ port, am, disk }) => {
    const key = { 'x-api-key': 'ci-key' };
    assert.equal((await post(port, { name: 'a', threshold: { bucket: 'unified5h', percent: 80 } }, key)).status, 403);
    assert.equal((await post(port, { name: 'a', remove: true, confirm: 'a' }, key)).status, 403);
    assert.equal(am.accounts.length, 2);
    assert.equal((await disk()).accounts[0].switchThreshold, undefined);
  }, { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'ci', key: 'ci-key' }] } });
});

// ── Unlink ────────────────────────────────────────────────────

test('unlink drops the account live and takes its entry and credentials off disk', async () => {
  await withServer(async ({ port, am, disk }) => {
    const res = await post(port, { name: 'a', remove: true, confirm: 'a' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { name: 'a', removed: true, persisted: true });
    assert.deepEqual(am.accounts.map(x => x.name), ['b']);
    const after = await disk();
    assert.deepEqual(after.accounts.map(x => x.name), ['b']);
    assert.equal(JSON.stringify(after).includes('sk-test-a'), false, 'the removed account\'s key must leave the file');
  });
});

test('unlink needs remove: true and the name typed back', async () => {
  await withServer(async ({ port, am, disk }) => {
    for (const body of [{ name: 'a', remove: true }, { name: 'a', remove: true, confirm: 'b' }, { name: 'a', remove: 'yes', confirm: 'a' }]) {
      assert.equal((await post(port, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(am.accounts.length, 2);
    assert.equal((await disk()).accounts.length, 2);
  });
});

test('unlink is refused while the account has requests in flight', async () => {
  await withServer(async ({ port, am, disk }) => {
    am.accounts[0].inFlight = 2;
    const res = await post(port, { name: 'a', remove: true, confirm: 'a' });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /2 requests in flight/);
    am.accounts[0].inFlight = 0;
    am.accounts[0].activityOpen = 1; // a stream still running after its headers
    assert.equal((await post(port, { name: 'a', remove: true, confirm: 'a' })).status, 409);
    assert.equal(am.accounts.length, 2);
    assert.equal((await disk()).accounts.length, 2);
  });
});

test('unlink without a save hook is refused up front', async () => {
  await withServer(async ({ port, am }) => {
    assert.equal((await post(port, { name: 'a', remove: true, confirm: 'a' })).status, 501);
    assert.equal(am.accounts.length, 2);
  }, { hooks: { persistAccounts: undefined } });
});

test('the old {name, disabled} body still works', async () => {
  await withServer(async ({ port, am }) => {
    const res = await post(port, { name: 'b', disabled: true });
    assert.equal(res.status, 200);
    assert.equal(am.accounts[1].disabled, true);
  });
});
