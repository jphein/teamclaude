import { configIndexFor, markAccountRemoved, unmarkAccountRemoved } from './account-pairing.js';

/**
 * Removing an account from the fleet, the one way every surface does it: the
 * dashboard's Unlink, the MCP remove_account tool and the TUI's Remove.
 *
 * The file goes first and the running fleet after, so a save that fails
 * changes nothing. While the save runs the account is out of rotation and
 * marked `_removing`, which AccountManager.setDisabled honours: a reload that
 * reads the row still on disk, or an enable from another surface, cannot put
 * it back. An account with requests still running is refused rather than cut
 * off mid-stream, and so is one not paired with a config entry, whose row could
 * not be found to remove.
 */

/** A refused or failed removal; `status` is what an HTTP caller answers. */
export class RemovalError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * @param {{
 *   accountManager: any,
 *   config: { accounts?: any[] },
 *   index: number,
 *   persist: (id: string) => Promise<unknown>,
 * }} args  `persist` writes the removal to the config file. The entry is
 *   already out of `config.accounts` and recorded as removed when it runs, so a
 *   merge-save omits it; a caller may also filter the file by `id` directly.
 * @returns {Promise<{ name: string, id: string, account: any }>}
 */
export async function removeAccountGuarded({ accountManager, config, index, persist }) {
  const account = accountManager.accounts[index];
  if (!account) throw new RemovalError(404, 'no such account');
  const name = account.name;
  if (account._removing) throw new RemovalError(409, `"${name}" is already being removed`);
  const live = Math.max(account.inFlight || 0, account.activityOpen || 0);
  if (live > 0) throw new RemovalError(409, `"${name}" has ${live} request${live === 1 ? '' : 's'} in flight; try again when they finish`);
  const accounts = config.accounts || [];
  const entryIndex = configIndexFor(accounts, accountManager.accounts, index);
  if (entryIndex < 0) throw new RemovalError(409, `"${name}" is not paired with an entry in the config file; reload and try again`);
  const entry = accounts[entryIndex];
  const id = entry.id;

  const wasDisabled = account.disabled;
  account._removing = true;
  account.disabled = true;
  markAccountRemoved(config, id);
  accounts.splice(entryIndex, 1);
  try {
    await persist(id);
  } catch (err) {
    accounts.splice(Math.min(entryIndex, accounts.length), 0, entry);
    unmarkAccountRemoved(config, id);
    account._removing = false;
    account.disabled = wasDisabled;
    const e = new RemovalError(500, `${name}: the config file could not be saved, so nothing was removed`);
    /** @type {any} */ (e).cause = err;
    throw e;
  }
  // By identity: the list may have been reordered while the save ran.
  const now = accountManager.accounts.indexOf(account);
  if (now >= 0) accountManager.removeAccount(now);
  return { name, id, account };
}
