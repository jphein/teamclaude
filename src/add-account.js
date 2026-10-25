// Browser-driven sign-in for a NEW account — the engine behind the dashboard's
// "Add account" button (the /teamclaude/add-account* control endpoints). The
// session half is the same as reauth.js: a PKCE flow started server-side, the
// browser opens the authorize URL, and completion races the localhost callback
// against a code pasted into the dashboard. The save half is what differs: a
// reauth writes tokens into a row it already knows, while this hands the fresh
// credentials to the same upsert `teamclaude login` uses, so profile-based
// naming, account+org dedup, the multi-org " (Org)" disambiguation and the
// callback.net record all come out the same as a CLI login would.
//
// One session at a time, and never alongside a reauth: both are single-human
// control surfaces, and two PKCE listeners racing for one browser is exactly
// the confusion a dashboard exists to avoid.

import { createOAuthSession, parseAuthCodeInput } from './oauth.js';

/** @param {number} status @param {string} message */
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * @param {object} opts
 * @param {(creds: any, name: string | null) => Promise<{ action: 'added' | 'updated', name: string, email?: string | null }>} opts.saveAccount
 *   persists the credentials as a new (or, when the identity already exists,
 *   updated) account entry and returns what happened; throws with a message
 *   for the person when the account cannot be identified or saved
 * @param {() => Promise<unknown>} opts.reload  propagate the saved row into the running fleet
 * @param {() => Promise<any>} [opts.createSession]
 * @param {() => boolean} [opts.otherSessionPending]  true while a reauth is pending
 * @param {(msg: string) => void} [opts.log]
 */
export function createAddAccountManager({
  saveAccount,
  reload,
  createSession = createOAuthSession,
  otherSessionPending = () => false,
  log = console.log,
}) {
  /** @typedef {{ requestedName: string | null, name: string | null, session: any, state: 'pending' | 'done' | 'error',
   *   email: string | null, action: 'added' | 'updated' | null, error: string | null, settled: boolean }} Ctx */
  /** @type {Ctx | null} */
  let current = null;

  function status() {
    if (!current) return { state: 'idle', name: null, email: null, action: null, error: null };
    return { state: current.state, name: current.name, email: current.email, action: current.action, error: current.error };
  }

  /** @param {Ctx} ctx @param {string} message */
  function fail(ctx, message) {
    ctx.state = 'error';
    ctx.error = message;
    ctx.session.close();
  }

  /** @param {Ctx} ctx @param {string} code */
  async function complete(ctx, code) {
    if (ctx.settled) return;
    ctx.settled = true;
    try {
      const creds = await ctx.session.exchange(code);
      const outcome = await saveAccount(creds, ctx.requestedName);
      await reload();
      ctx.state = 'done';
      ctx.name = outcome.name;
      ctx.action = outcome.action;
      ctx.email = outcome.email || null;
      ctx.session.close();
      log(`[TeamClaude] ${outcome.action === 'updated' ? 'Updated' : 'Added'} account "${outcome.name}" via dashboard`);
    } catch (err) {
      fail(ctx, /** @type {any} */ (err)?.message || String(err));
    }
  }

  return {
    status,

    pending: () => !!current && current.state === 'pending',

    /** @param {{ name?: string | null }} [opts] */
    async start({ name = null } = {}) {
      if (otherSessionPending()) throw httpError(409, 'a reauth is already waiting for a browser approval — finish or cancel it first');
      const requestedName = typeof name === 'string' && name.trim() ? name.trim() : null;

      if (current) current.session.close(); // supersede any prior session

      const session = await createSession();
      /** @type {Ctx} */
      const ctx = { requestedName, name: requestedName, session, state: 'pending', email: null, action: null, error: null, settled: false };
      current = ctx;

      session.codePromise.then(
        (/** @type {string} */ code) => { if (current === ctx && !ctx.settled) return complete(ctx, code); },
        (/** @type {any} */ err) => {
          if (current === ctx && !ctx.settled) {
            ctx.settled = true;
            fail(ctx, err.message || String(err));
          }
        },
      );

      log(`[TeamClaude] Add account started${requestedName ? ` as "${requestedName}"` : ''} — waiting for browser approval`);
      return { authUrl: session.authUrl };
    },

    /** @param {string} text */
    async submitCode(text) {
      const ctx = current;
      if (!ctx || ctx.state !== 'pending') throw httpError(409, 'no add-account session pending');

      let code;
      try {
        code = parseAuthCodeInput(text, ctx.session.state);
      } catch (err) {
        ctx.settled = true;
        fail(ctx, /** @type {any} */ (err)?.message || String(err));
        return status();
      }
      if (!code) throw httpError(400, 'no authorization code in input');

      await complete(ctx, code);
      return status();
    },

    cancel() {
      if (current) {
        current.session.close();
        current = null;
      }
    },
  };
}
