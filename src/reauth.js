// Interactive re-authentication for an existing account — the engine behind
// the dashboard's per-account Reauth button (the /teamclaude/reauth* control
// endpoints). Runs the same PKCE flow as `teamclaude login`, but server-side:
// the browser opens the authorize URL, and completion races the localhost
// callback (automatic when browsing on the proxy host) against a code the user
// pastes into the dashboard.
//
// One session at a time: the dashboard is a single-human control surface, so a
// new start() supersedes a pending session. Lives outside index.js (the CLI
// entry executes on import) so it can be unit-tested; collaborators arrive via
// options for the same reason.

import { createOAuthSession, fetchProfile, parseAuthCodeInput } from './oauth.js';
import { sameIdentity, emailOf } from './identity.js';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** The owner of a session started by the operator (shared key, loopback, SSO). */
export const OPERATOR = 'operator';

export function createReauthManager({
  accountManager,
  persistTokens,
  reload,
  createSession = createOAuthSession,
  fetchProfileFn = fetchProfile,
  otherSessionPending = () => false,
  log = console.log,
}) {
  // Current session context, or null when idle. `settled` flips exactly once:
  // the callback and a pasted code can race, and only the first may complete.
  /** @type {any} the pending (or last) session */
  let current = null;
  // Starts awaiting their session: counted so the Add account flow's exclusion
  // check sees them before `current` is published.
  let starting = 0;

  function status() {
    if (!current) return { state: 'idle', account: null, email: null, error: null };
    return { state: current.state, account: current.name, email: current.email, error: current.error };
  }

  function fail(ctx, message) {
    ctx.state = 'error';
    ctx.error = message;
    ctx.session.close();
  }

  // The freshly-issued token must belong to the account being reauthed —
  // approving the OAuth page while logged into the wrong claude.ai account is
  // the classic relogin footgun. UUID-bearing entries use the same account+org
  // identity rule as the account list; legacy entries (no stored uuid) fall
  // back to the email-ish display name and get their uuids backfilled.
  // An entry with neither a stored uuid nor an email-shaped name: any sign-in
  // would be accepted for it, so only the operator holding the key may reauth it.
  function unverifiable(account) {
    return !account.accountUuid && !emailOf(account).includes('@');
  }

  function identityMatches(account, profile) {
    if (account.accountUuid) {
      return sameIdentity(account, {
        accountUuid: profile.accountUuid,
        orgUuid: profile.orgUuid,
        orgName: profile.orgName,
      });
    }
    const email = emailOf(account);
    if (email.includes('@') && profile.email) {
      return email.toLowerCase() === profile.email.toLowerCase();
    }
    return true; // unverifiable legacy entry — accept and backfill
  }

  async function complete(ctx, code) {
    if (ctx.settled) return;
    ctx.settled = true;
    try {
      const creds = await ctx.session.exchange(code);
      const profile = await fetchProfileFn(creds.accessToken);
      if (!profile || profile.error) {
        fail(ctx, `could not fetch account profile — ${profile?.error || 'no response'}`);
        return;
      }
      if (!identityMatches(ctx.account, profile)) {
        const who = profile.email || 'an unknown account';
        const org = profile.orgName ? ` (${profile.orgName})` : '';
        fail(ctx, `logged in as ${who}${org}, expected ${ctx.name} — nothing saved`);
        return;
      }
      await persistTokens(ctx.name, creds, profile);
      await reload();
      ctx.state = 'done';
      ctx.email = profile.email || null;
      ctx.session.close();
      log(`[TeamClaude] Reauthed "${ctx.name}" via dashboard`);
    } catch (err) {
      fail(ctx, err.message || String(err));
    }
  }

  // Who may touch the pending session (2026-10-27): its owner, or the
  // operator. Every lane on a host holds a client key, so without this any of
  // them could close, cancel or fail (a wrong-state code fails a session) the
  // sign-in the operator is in the middle of. The identity check already
  // stopped a swap; this stops the disruption.
  //
  // A start is reserved BEFORE it awaits createSession (the owner and a
  // generation number), and publishes only if no later start or cancel
  // happened meanwhile — checking only before the await let a client's slower
  // start overwrite the operator's newer session (Oracle + xreview, 2026-10-27).
  /** @type {{ gen: number, owner: string, name: string } | null} a start awaiting its session */
  let reserved = null;
  let generation = 0;
  /** Who holds the flow now: a start in progress, else a pending session. */
  function holder() {
    if (reserved) return { owner: reserved.owner, name: reserved.name };
    if (current && current.state === 'pending') return { owner: current.owner, name: current.name };
    return null;
  }
  /** @param {string} who */
  function mayTouch(who) {
    const h = holder();
    return !h || who === OPERATOR || h.owner === who;
  }
  const busy = () => {
    const h = holder();
    return httpError(409, `a reauth for "${h?.name}" started by ${h?.owner === OPERATOR ? 'the operator' : 'another client'} is waiting for a browser approval; it can only be replaced or cancelled by whoever started it, or the operator`);
  };

  return {
    status,

    pending: () => starting > 0 || status().state === 'pending',

    /**
     * @param {string} name
     * @param {{ strict?: boolean, owner?: string }} [opts]  strict: the caller is
     *   not the key-holding operator (a client key, or a dashboard SSO sign-in),
     *   so an account whose identity cannot be checked is refused. owner: who is
     *   starting it — OPERATOR, or `client:<name>`.
     */
    async start(name, { strict = false, owner = OPERATOR } = {}) {
      if (otherSessionPending()) throw httpError(409, 'an add-account sign-in is already waiting for a browser approval — finish or cancel it first');
      const account = accountManager.accounts.find(a => a.name === name);
      if (!account) throw httpError(404, `account "${name}" not found`);
      if (account.type !== 'oauth') throw httpError(400, `account "${name}" is not an OAuth account`);
      if (strict && unverifiable(account)) throw httpError(403, `account "${name}" has no stored identity to check a sign-in against; reauth it with the proxy key (the desktop launcher)`);

      if (!mayTouch(owner)) throw busy();
      const gen = ++generation;
      reserved = { gen, owner, name };

      starting++;
      let session;
      try { session = await createSession(); } catch (err) {
        if (reserved?.gen === gen) reserved = null;
        throw err;
      } finally { starting--; }
      // A later start or a cancel took over while this one waited: it lost.
      if (gen !== generation) {
        session.close();
        throw httpError(409, 'this reauth was replaced or cancelled while it was starting');
      }
      reserved = null;
      if (current) current.session.close(); // supersede any prior session
      const ctx = { name, account, session, owner, state: 'pending', email: null, error: null, settled: false };
      current = ctx;

      // Browser-callback completion path. A session that was superseded or
      // cancelled (current !== ctx) must never complete against the manager.
      session.codePromise.then(
        code => { if (current === ctx && !ctx.settled) return complete(ctx, code); },
        err => {
          if (current === ctx && !ctx.settled) {
            ctx.settled = true;
            fail(ctx, err.message || String(err));
          }
        },
      );

      log(`[TeamClaude] Reauth started for "${name}" — waiting for browser approval`);
      return { authUrl: session.authUrl };
    },

    /** @param {string} text @param {{ owner?: string }} [opts] */
    async submitCode(text, { owner = OPERATOR } = {}) {
      const ctx = current;
      if (!ctx || ctx.state !== 'pending') throw httpError(409, 'no reauth session pending');
      if (!mayTouch(owner)) throw busy();

      let code;
      try {
        code = parseAuthCodeInput(text, ctx.session.state);
      } catch (err) {
        // Wrong-state URL: the pasted code belongs to a different login
        // attempt, so the session cannot succeed — fail it outright.
        ctx.settled = true;
        fail(ctx, err.message);
        return status();
      }
      if (!code) throw httpError(400, 'no authorization code in input');

      await complete(ctx, code);
      return status();
    },

    /** @param {{ owner?: string }} [opts] */
    cancel({ owner = OPERATOR } = {}) {
      if (!mayTouch(owner)) throw busy();
      // Not even a finished session's result may be cleared by a stranger.
      if (current && owner !== OPERATOR && current.owner !== owner) throw httpError(409, 'that reauth was started by someone else; only they or the operator may clear it');
      generation++; // a start still waiting for its session loses
      reserved = null;
      if (current) {
        current.session.close();
        current = null;
      }
    },
  };
}
