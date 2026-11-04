import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { removeAccountGuarded, RemovalError } from '../src/account-removal.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { removedAccountIds } from '../src/account-pairing.js';
import { TUI } from '../src/tui.js';

// One removal for every surface (dashboard Unlink, MCP remove_account, TUI
// Remove): refused while requests run, the file first and the live fleet
// after, and nothing — a reload reading the old row included — puts the
// account back in rotation while the save is pending.

const entry = (id, name) => ({ id, name, type: 'apikey', apiKey: `sk-test-${id}` });

function fleet() {
  const disk = [entry('a', 'a@example.com'), entry('b', 'b@example.com')];
  const config = { accounts: disk.map(e => ({ ...e })) };
  const am = new AccountManager(disk.map(e => ({ ...e })), 0.98);
  return { disk, config, am };
}

test('the file is written before the account leaves the fleet', async () => {
  const { config, am } = fleet();
  const seen = [];
  const out = await removeAccountGuarded({
    accountManager: am, config, index: 1,
    persist: async (id) => { seen.push({ id, live: am.accounts.map(a => a.name), disabled: am.accounts[1].disabled, cfg: config.accounts.map(a => a.id) }); },
  });
  assert.equal(out.name, 'b@example.com');
  assert.deepEqual(seen, [{ id: 'b', live: ['a@example.com', 'b@example.com'], disabled: true, cfg: ['a'] }]);
  assert.deepEqual(am.accounts.map(a => a.name), ['a@example.com']);
  assert.ok(removedAccountIds(config).has('b'));
});

test('a reload during the save neither re-enables nor re-adds the account', async () => {
  const { disk, config, am } = fleet();
  let release;
  const held = new Promise(r => { release = r; });
  const removal = removeAccountGuarded({ accountManager: am, config, index: 1, persist: () => held });
  // The file still lists the row, without `disabled`: what a reload reads.
  await syncAccountsFromDisk({ accounts: disk.map(e => ({ ...e })) }, config, am);
  assert.equal(am.accounts.length, 2, 'not added a second time');
  assert.equal(am.accounts[1].disabled, true, 'still out of rotation');
  am.setDisabled(1, false); // an enable from any surface
  assert.equal(am.accounts[1].disabled, true);
  release();
  await removal;
  assert.deepEqual(am.accounts.map(a => a.name), ['a@example.com']);
});

test('a failed save removes nothing and puts the entry back where it was', async () => {
  const { config, am } = fleet();
  await assert.rejects(
    removeAccountGuarded({ accountManager: am, config, index: 0, persist: async () => { throw new Error('disk full'); } }),
    err => err instanceof RemovalError && err.status === 500 && /nothing was removed/.test(err.message),
  );
  assert.deepEqual(am.accounts.map(a => a.name), ['a@example.com', 'b@example.com']);
  assert.equal(am.accounts[0].disabled, false);
  assert.equal(am.accounts[0]._removing, false);
  assert.deepEqual(config.accounts.map(a => a.id), ['a', 'b'], 'same position');
  assert.equal(removedAccountIds(config).has('a'), false, 'no longer recorded as removed');
  // And it can be re-enabled and removed again later.
  am.setDisabled(0, true); am.setDisabled(0, false);
  assert.equal(am.accounts[0].disabled, false);
  await removeAccountGuarded({ accountManager: am, config, index: 0, persist: async () => {} });

});

test('refused: requests in flight, a removal already running, an unpaired account', async () => {
  const { config, am } = fleet();
  const persist = async () => { throw new Error('must not be called'); };
  am.accounts[0].inFlight = 1;
  await assert.rejects(removeAccountGuarded({ accountManager: am, config, index: 0, persist }), err => err.status === 409 && /in flight/.test(err.message));
  am.accounts[0].inFlight = 0;
  am.accounts[0].activityOpen = 2;
  await assert.rejects(removeAccountGuarded({ accountManager: am, config, index: 0, persist }), err => err.status === 409);
  am.accounts[0].activityOpen = 0;
  am.accounts[1].id = 'not-on-disk';
  await assert.rejects(removeAccountGuarded({ accountManager: am, config, index: 1, persist }), err => err.status === 409 && /not paired/.test(err.message));
  am.accounts[0]._removing = true;
  await assert.rejects(removeAccountGuarded({ accountManager: am, config, index: 0, persist }), err => err.status === 409 && /already being removed/.test(err.message));
  assert.equal(am.accounts.length, 2);
  assert.equal(config.accounts.length, 2);
});

test('the TUI refuses to remove an account with requests in flight, and says so', async () => {
  const { config, am } = fleet();
  const saves = [];
  const tui = new TUI({ accountManager: am, config, saveConfig: async () => { saves.push(1); }, syncAccounts: async () => 0, onQuit: () => {} });
  tui.render = () => {};
  am.accounts[0].inFlight = 1;
  await tui._doRemove(0);
  assert.equal(am.accounts.length, 2);
  assert.deepEqual(saves, []);
  assert.ok(tui.log.some(l => /Not removed: .*in flight/.test(l.msg)));
  am.accounts[0].inFlight = 0;
  await tui._doRemove(0);
  assert.deepEqual(am.accounts.map(a => a.name), ['b@example.com']);
  assert.deepEqual(saves, [1]);
});

test('a reload during a save that then fails leaves the account live and in rotation', async () => {
  const { disk, config, am } = fleet();
  let fail;
  const held = new Promise((_, reject) => { fail = reject; });
  const removal = removeAccountGuarded({ accountManager: am, config, index: 1, persist: () => held });
  await syncAccountsFromDisk({ accounts: disk.map(e => ({ ...e })) }, config, am);
  fail(new Error('disk full'));
  await assert.rejects(removal, err => err.status === 500);
  assert.deepEqual(am.accounts.map(a => a.name), ['a@example.com', 'b@example.com']);
  assert.equal(am.accounts[1].disabled, false);
  // The next reload agrees with the fleet: nothing added, nothing dropped.
  const { added, removed } = await syncAccountsFromDisk({ accounts: disk.map(e => ({ ...e })) }, config, am);
  assert.deepEqual({ added, removed }, { added: 0, removed: 0 });
});
