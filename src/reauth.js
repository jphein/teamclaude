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

export function createReauthManager({
  accountManager,
  persistTokens,
  reload,
  createSession = createOAuthSession,
  fetchProfileFn = fetchProfile,
  log = console.log,
}) {
  // Current session context, or null when idle. `settled` flips exactly once:
  // the callback and a pasted code can race, and only the first may complete.
  let current = null;

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

  return {
    status,

    async start(name) {
      const account = accountManager.accounts.find(a => a.name === name);
      if (!account) throw httpError(404, `account "${name}" not found`);
      if (account.type !== 'oauth') throw httpError(400, `account "${name}" is not an OAuth account`);

      if (current) current.session.close(); // supersede any prior session

      const session = await createSession();
      const ctx = { name, account, session, state: 'pending', email: null, error: null, settled: false };
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

    async submitCode(text) {
      const ctx = current;
      if (!ctx || ctx.state !== 'pending') throw httpError(409, 'no reauth session pending');

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

    cancel() {
      if (current) {
        current.session.close();
        current = null;
      }
    },
  };
}
