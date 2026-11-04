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
// Removals run one at a time, whole: a save writes the shared config, so one
// removal's save would otherwise write another's pending omission, and that
// one's later failure could not take it back; nor could two rollbacks put
// their entries back in the right order (xreview, 2026-11-04).
/** @type {Promise<unknown>} */
let queue = Promise.resolve();

export function removeAccountGuarded({ accountManager, config, index, persist }) {
  // The account by identity, now: a removal queued behind another would find
  // the list renumbered, and an index would name a neighbour.
  const account = accountManager.accounts[index];
  if (!account) return Promise.reject(new RemovalError(404, 'no such account'));
  const run = queue.then(() => removeOne({ accountManager, config, account, persist }));
  queue = run.catch(() => {});
  return run;
}

/** @param {{ accountManager: any, config: { accounts?: any[] }, account: any, persist: (id: string) => Promise<unknown> }} args */
async function removeOne({ accountManager, config, account, persist }) {
  const name = account.name;
  const index = accountManager.accounts.indexOf(account);
  if (index < 0) throw new RemovalError(404, `"${name}" is no longer in the fleet`);
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
  account._disableAsked = false;
  account.disabled = true;
  markAccountRemoved(config, id);
  accounts.splice(entryIndex, 1);
  try {
    await persist(id);
  } catch (err) {
    accounts.splice(Math.min(entryIndex, accounts.length), 0, entry);
    unmarkAccountRemoved(config, id);
    account._removing = false;
    // A disable asked for while the save ran (setDisabled) stands.
    account.disabled = wasDisabled || account._disableAsked;
    delete account._disableAsked;
    const e = new RemovalError(500, `${name}: the config file could not be saved, so nothing was removed`);
    /** @type {any} */ (e).cause = err;
    throw e;
  }
  delete account._disableAsked;
  // By identity: the list may have been reordered while the save ran.
  const now = accountManager.accounts.indexOf(account);
  if (now >= 0) accountManager.removeAccount(now);
  return { name, id, account };
}
