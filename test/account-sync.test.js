import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/account-sync.js';

function oauth(extra = {}) {
  return {
    name: 'a@x.org', type: 'oauth', accountUuid: 'u1', orgUuid: 'o1',
    accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
    ...extra,
  };
}

// `teamclaude enable` is documented to clear a stuck 'error' state, but it only
// deletes the (often already-absent) disabled flag from config and triggers a
// reload. The sync must therefore clear the error whenever the disk says the
// account is enabled — not only when the disabled flag actually changed.
test('sync clears a stuck error on an account the config says is enabled', async () => {
  const a = oauth();
  const am = new AccountManager([a], 0.98);
  am.accounts[0].status = 'error'; // errored at runtime, never disabled

  const memConfig = { accounts: [{ ...a }] };
  const diskConfig = { accounts: [{ ...a }] }; // same creds, no disabled flag

  const added = await syncAccountsFromDisk(diskConfig, memConfig, am);

  assert.equal(added, 0);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am._isAvailable(am.accounts[0]), true);
});

test('sync leaves a disk-disabled errored account disabled and errored', async () => {
  const a = oauth();
  const am = new AccountManager([a], 0.98);
  am.accounts[0].status = 'error';

  const memConfig = { accounts: [{ ...a }] };
  const diskConfig = { accounts: [{ ...a, disabled: true }] };

  await syncAccountsFromDisk(diskConfig, memConfig, am);

  assert.equal(am.accounts[0].disabled, true);
  assert.equal(am.accounts[0].status, 'error'); // disabling never clobbers the error
});

test('sync adds a new disk account and reports the count', async () => {
  const a = oauth();
  const b = oauth({ name: 'b@x.org', accountUuid: 'u2' });
  const am = new AccountManager([a], 0.98);

  const memConfig = { accounts: [{ ...a }] };
  const diskConfig = { accounts: [{ ...a }, { ...b }] };

  const added = await syncAccountsFromDisk(diskConfig, memConfig, am);

  assert.equal(added, 1);
  assert.equal(am.accounts.length, 2);
  assert.equal(am.accounts[1].name, 'b@x.org');
  assert.equal(memConfig.accounts.length, 2);
});
