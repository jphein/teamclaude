# Web dashboard: per-account Reauth button — design

**Date:** 2026-08-07 · **Status:** approved (JP, this session) · **Base:** post-cutover master (upstream v1.1.7 + web dashboard port)

## Problem

When an account's refresh token is revoked (`invalid_grant`), recovery today is
CLI-only: `teamclaude login` on the proxy host (wrapped by the ad-hoc
`scripts/relogin.sh`). The headless dashboard can see the error but can't fix
it. The manual flow also has a footgun: approving the OAuth page while the
browser is logged into the *wrong* claude.ai account silently updates the wrong
entry.

## Design

Server-driven PKCE flow, mirroring `loginOAuth()`'s callback-vs-paste race,
with the browser dashboard as the front end.

### Flow

1. **Reauth** button (ghost style) on each `oauth`-type account card →
   `POST /teamclaude/reauth {name}`. Server creates a PKCE session (verifier +
   state), starts the localhost callback listener (random port, 2-min timeout,
   single pending session — a new start cancels the prior), returns `{authUrl}`.
2. Dashboard opens `authUrl` in a new tab; the card shows a pending panel:
   "waiting for browser approval…", a paste-code input, and a cancel link.
3. Completion races, as in the CLI:
   - callback hits the localhost listener (automatic when browsing on the proxy
     host), or
   - user pastes the code claude.ai displays (`code=true`) →
     `POST /teamclaude/reauth/code {code}` — accepts a raw code or the full
     callback URL, same parsing as the stdin path.
4. Dashboard polls `GET /teamclaude/reauth` (~2s while pending) →
   `{state: idle|pending|done|error, account, email?, error?}`.

### Completion (server side)

exchange code → `fetchProfile` → **identity guard** → persist → live reload:

- **Identity guard:** the profile must satisfy `sameIdentity` against the
  target account (accountUuid + org key). On mismatch nothing is saved and the
  error reads "logged in as X, expected Y". Accounts predating stored UUIDs
  (no `accountUuid` on record) fall back to name/email comparison via
  `sameIdentity`'s existing rules, and successful reauth backfills the UUIDs.
- **Persist:** `atomicConfigUpdate` writes accessToken/refreshToken/expiresAt
  (+ backfilled accountUuid/orgUuid/orgName) onto the matching disk entry.
- **Reload:** `hooks.reload()` (existing `syncAccountsFromDisk`) propagates the
  fresh tokens into the running manager and clears a stuck `error` status.
- Emits `reauth` activity events so the feed shows start/success/failure.

### Code layout

- `src/oauth.js` — extract the PKCE-session guts of `loginOAuth()` into
  `createOAuthSession()` (returns `{authUrl, state, codePromise, exchange,
  close}`) and export `parseAuthCodeInput(text, expectedState)`; `loginOAuth()`
  becomes a thin CLI wrapper. No behavior change.
- `src/reauth.js` — `createReauthManager({accountManager, createSession,
  fetchProfileFn, persistTokens, reload})` with `start(name)`, `submitCode(text)`,
  `status()`, `cancel()`. DI keeps it unit-testable without the CLI entry.
- `src/index.js` — wires `hooks.reauth` (persist via `atomicConfigUpdate`,
  reload via `reloadAccounts`), next to the other dashboard hooks.
- `src/server.js` — routes `POST /teamclaude/reauth`, `POST
  /teamclaude/reauth/code`, `POST /teamclaude/reauth/cancel` (all three join
  `MUTATING_CONTROL` for the CSRF header guard) and `GET /teamclaude/reauth`.
- `src/web/index.html` — button on oauth cards, pending panel, status poll,
  toast on done/error. Paste input survives the 2s card re-render.

### Errors

- 2-min timeout → session expires, card resets, error toast.
- state mismatch / exchange failure / identity mismatch → error state with
  message; nothing persisted.
- `apikey` accounts: no button; `POST /teamclaude/reauth` returns 400.
- No `hooks.reauth` (embedded use): 501, matching the other control endpoints.

### Testing

`test/reauth.test.js`: manager unit tests (happy path, identity mismatch,
timeout, cancel, code-vs-URL parsing) with stubbed session/profile/persist;
endpoint tests on the web-dashboard harness pattern (CSRF guard included).

## Alternatives considered

- **Paste-only flow** (no callback listener): simpler, but a manual paste even
  when browsing on the proxy host. Rejected — JP picked callback + paste.
- **Reauth to any account** (no identity guard): rejected; codifying the
  relogin.sh warning server-side is half the point.
