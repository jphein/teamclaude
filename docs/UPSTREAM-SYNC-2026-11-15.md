# Upstream sync triage, 2026-11-15

Fork jphein/teamclaude against KarpelesLab/teamclaude `upstream/master` (a02ce29, v1.1.29-26-ga02ce29).
Merge base d50ca5c (v1.1.26, synced 2026-10-21 in merge commit 7b53e6f). At triage: **87 behind, 215 ahead**.
Raised by realmwatch's CHECK fork-drift (realmwatch#471). Owner: the teamclaude lane.

**Method: cherry-pick split, never a whole merge.** Every upstream commit was trial-picked, alone and in order,
onto `origin/master` in an unsynced clone (`~/srv/wt/tc-upstream-trial`): 26 applied cleanly, 61 conflicted (many only
because an earlier commit was not taken). The clean set was then gated as a whole (`npm run gate`); commits that
broke fork tests were moved to a later wave, and one was dropped after the cross-model review.

| Verdict | Count | Meaning |
|---|---|---|
| W1 | 21 | taken in this PR |
| W2 | 28 | take next: security, reauth and robustness fixes that need adapting to fork code; due Tue 2026-11-17 |
| W3 | 21 | features and TUI/log polish; adapt or decline one by one; due Fri 2026-11-20 |
| HAVE | 3 | the fork already has an equivalent |
| SKIP | 14 | not used here (Codex, API-key billing, adaptive placement), version bumps, or rejected |

Wave 1 gate: 3747 pass, 0 fail; lint, typecheck, strict ratchet ok. Perturbation: undoing #616's fix in
`src/sync-accounts.js` turns `test/reload-keeps-error.test.js` red (1 of 2), restoring it green.
Cross-model review (Foundry gpt-6.1-sol) on the wave 1 source diff, 3 findings:
1. `CALLBACK_API_BASE` / `SX_API_BASE` still accept any https host. Predates this diff; neither variable is set
   anywhere in the fleet and callback.net sync is not signed in on the VM. Noted, not changed.
2. Credential sync can still write after its refresh lease expired. #697 narrows this, it does not widen it; the
   code runs only when signed in to callback.net, which no install here is. Noted.
3. #623 (2730239) set the unrenewed 503 Retry-After to the LONGEST refresh hold: one seat held for an hour would park
   every client an hour while another seat could renew in seconds. **Dropped (SKIP)**; the fork keeps 30 s.

## Per commit (upstream order)

| Upstream | Trial | Verdict | Why |
|---|---|---|---|
| `90fa5cb` test(quota): pin the clock in the banked-reset probe tests (#605) | CONFLICT | HAVE | fork #35 already pinned the banked-reset test clock (different fix) |
| `6820487` chore(ci): bump cachix/install-nix-action from 31.11.2 to 31.11.3 (#590) | CLEAN | W1 | CI action bump, SHA-pinned |
| `2d9b975` chore(ci): bump docker/login-action from 4.6.0 to 4.7.0 (#591) | CLEAN | W1 | CI action bump, SHA-pinned |
| `61aeca4` fix(reload): unchanged tokens no longer revive an access-token-only account in error (#616) | CLEAN | W1 | reload no longer revives an errored access-token-only account |
| `5831c18` fix(routing): keep the session-reset switch inside the requesting provider (#604) | CONFLICT | W3 | session-reset switch stays in its provider; fork serves one provider |
| `d62e052` fix: serialise breaking a stale config lock (#607) | CLEAN | W1 | stale config lock broken under a lock |
| `1a36775` fix(hold): a held request retries accounts that recovered after it failed over (#603) | CLEAN | W2 | held request retries recovered accounts; breaks 9 fork hold tests, adapt to the fork's hold |
| `ceb60d3` fix(status): a Codex account's adaptive row names its own window, not opus+ (#598) | CLEAN | W1 | Codex status row; inert here |
| `3be19b4` feat(429): mark the all-exhausted refusal with error_code pool_exhausted and its reset time (#597) | CLEAN | W1 | all-exhausted 429 carries error_code pool_exhausted + reset (adds fields only) |
| `80719eb` fix(server): request ids are unique across the base and MITM listeners (#596) | CONFLICT | W2 | request ids unique across base and MITM listeners (server.js conflict) |
| `d61651e` fix(quota): read z.ai CREDIT_LIMIT windows from their credits (#624) | CLEAN | W1 | z.ai credit windows; inert here |
| `2730239` fix(server): the unrenewed answer's Retry-After is the token endpoint's, not a fixed 30 s (#623) | CLEAN | SKIP | unrenewed 503 Retry-After = LONGEST refresh hold (xreview: one hour-held seat parks clients an hour while another could renew); fork keeps 30 s |
| `1a140b5` fix(callback): an unacceptable CALLBACK_API_BASE is refused, not replaced by callback.net (#625) | CLEAN | W1 | bad CALLBACK_API_BASE refused, not replaced |
| `5485f3d` Find native claude for keep-warm when the service PATH lacks it (#592) | CONFLICT | W3 | keep-warm finds native claude; fork warmer rewritten (#59/#61/#64), adapt |
| `8e74b30` feat(dashboard): group account cards by provider (#579) | CONFLICT | SKIP | dashboard groups cards by provider; fork dashboard is custom and single-provider |
| `186ba30` fix(server): send scope 403s on Claude Code's own calls with the client credential (#584) | CONFLICT | W2 | scope 403s on Claude Code's own calls answered with the client credential |
| `9563ecc` feat(probe): probeDisabledAccounts keeps disabled accounts' quota fresh (#612) | CLEAN | W2 | probeDisabledAccounts; needs a src/settings.js FIELDS entry (fork's Settings coverage test) |
| `d206ad8` feat(quota): state the pool's headroom to the client until the last account (#617) | CONFLICT | W3 | pool headroom stated to the client |
| `16ff4cd` feat(server): CLIProxyAPI-compatible usage API for usage dashboards (off by default) (#594) | CONFLICT | SKIP | CLIProxyAPI-compatible usage API, off by default, no consumer here |
| `5237028` fix(max-spend): hold a spend-capped account to its included quota (#595) | CLEAN | W1 | spend-capped account held to its included quota |
| `19a8fb9` feat(auth): client keys scoped to inference cannot reach control routes (#599) | CONFLICT | W2 | SECURITY: inference-scoped client keys cannot reach control routes; map onto fork client keys (fable.allow) |
| `c17f0e7` feat(server): name an identity-verification hold instead of a credential refusal (#619) | CONFLICT | W2 | identity-verification hold named |
| `18a847f` fix(billing): fail over when an account has no API credit (#626) | CONFLICT | SKIP | API-key billing failover; fleet is OAuth seats only |
| `73c1316` feat(quota): store a bounded quota series and forecast when the fleet runs out (#550) (#578) | CONFLICT | W3 | bounded quota series + forecast; candidate feed for CHECK pool-quota |
| `62b4980` fix(quota): record when a Claude subscription meters no 5-hour window (Ultra) (#622) | CONFLICT | W2 | subscription with no 5-hour window (Ultra); compare fork #62 windowStart fix |
| `40b2c75` feat(routing): opt-in adaptiveDistribution.scoring "pressure" for adaptive placement (#577) | CONFLICT | SKIP | adaptive pressure scoring; fork routes by expiryRouting, distributeSessions off |
| `ef77a3c` fix(tui): name why an account is in error, with the status line under its row (#614) | CONFLICT | W3 | TUI names why an account is in error |
| `3ff61c2` feat(probe): re-read the OAuth profile and report a plan that lapses (#610) | CLEAN | W2 | re-read OAuth profile, report a lapsed plan (needs 9563ecc) |
| `96e1255` feat(server): drain refuses new requests while in-flight ones finish (#601) | CONFLICT | W2 | drain refuses new requests while in-flight finish; closes DEFERRALS-11-07 "drain in-flight on SIGTERM" |
| `f3babcc` feat(server): correlate a request by its x-request-id and count its upstream attempts (#600) | CONFLICT | W2 | x-request-id correlation + upstream attempt count |
| `471b4f4` fix(entitlement): a repeated OAuth entitlement denial waits longer and stays in status (#613) | CONFLICT | W2 | repeated OAuth entitlement denial waits longer (fork has the MITM entitlement path) |
| `19b871d` Bump to 1.1.27 (#627) | CONFLICT | SKIP | version bump; fork versions itself |
| `be15033` fix(tui): the ⊘ tag names the spent weekly, not a family (#637) | CLEAN | W1 | TUI ⊘ tag names the spent weekly |
| `2571d0b` fix(logs): name the quota bucket that fired in the near-quota lines (#639) | CONFLICT | HAVE | fork #65 near-quota lines already name the tripped bucket |
| `5988d9b` fix(sx): an unacceptable SX_API_BASE is refused, not replaced by api.sx.org (#632) | CLEAN | W1 | bad SX_API_BASE refused; inert here |
| `5040639` fix(server): keep client control-plane calls out of account rotation (#635) | CONFLICT | W2 | client control-plane calls kept out of account rotation |
| `6ee695b` fix(service): wait for launchd to release the old agent before loading the new one (#630) | CLEAN | W1 | launchd service wait; inert on Linux |
| `3a5bb67` feat(quota): show an API-key account's prepaid credit, from the Admin API cost report or a local estimate (#649) | CONFLICT | SKIP | API-key prepaid credit display |
| `5c64bd9` feat(routing): a pin may list API-key accounts and move along it on a billing refusal (#645) | CONFLICT | SKIP | pins over API-key accounts |
| `461b204` fix(reload): deleting accounts[].priority returns the running account to 0 (#650) | CLEAN | W1 | deleting accounts[].priority returns it to 0 |
| `6d055f9` feat(routing): opt-in preferSoonestWeeklyReset for earliest-deadline-first rotation (#636) | CONFLICT | HAVE | fork expiryRouting.rank "soonest" (#54) is the same idea |
| `157b7f4` feat(codex): fail over when a ChatGPT plan does not serve the model (#633) | CONFLICT | SKIP | Codex/ChatGPT failover; no Codex accounts |
| `caa967a` feat(routing): cordon an account — no new conversations go to it, the ones on it stay (#647) | CONFLICT | W3 | cordon an account (ops feature) |
| `21dc23c` feat(activity): end each request line with the response's cache figures (#653) | CONFLICT | W3 | activity line cache figures |
| `e5f9eb5` feat(status): keep the token endpoint's reason and the last good refresh beside refresh_rejected (#651) | CONFLICT | W2 | keep the token endpoint's reason + last good refresh (reauth diagnostics) |
| `143b514` fix(logs): the hold lines say when a spent window outlasts the hold (#652) | CLEAN | W2 | hold lines say when a spent window outlasts the hold; breaks 4 fork hold tests, take with 1a36775 |
| `ff6cae4` fix(logs): the advisor degrade line says how the degraded walk ended (#654) | CLEAN | W1 | advisor degrade log line |
| `e6b6f6e` fix(routing): an advisor family cap holds on every selection path (#655) | CONFLICT | W3 | advisor family cap on every selection path |
| `e04365e` feat(adaptive): pressureFiveHour scales a placement by its 5-hour room (#656) | CONFLICT | SKIP | adaptive pressureFiveHour (adaptive placement unused) |
| `7a3e1f0` feat(adaptive): fiveHourSoftMargin keeps new sessions off an account near its 5-hour cap (#657) | CONFLICT | SKIP | adaptive fiveHourSoftMargin (fork staggers windows instead, #61/#64) |
| `5a15f4b` feat(routing): teamclaude release unpins the conversations on one account (#658) | CONFLICT | W3 | teamclaude release unpins one account's conversations |
| `7e9549f` docs(routing): a switch is a certain cache miss only across organizations (#659) | CLEAN | W1 | docs |
| `f3c6036` Bump to 1.1.28 (#660) | CONFLICT | SKIP | version bump |
| `f17ea4f` fix(server): relay WebFetch preflight to the primary upstream (#661) | CONFLICT | W2 | WebFetch preflight relayed to the primary upstream |
| `d25032f` feat(server): proxy.controlPlane can route Claude Code's control-plane calls through the pool (#663) | CONFLICT | W3 | proxy.controlPlane through the pool (opt-in) |
| `f8e16d5` docs(routing): how much a family model's spend moves the shared weekly (#662) (#669) | CLEAN | W1 | docs |
| `9aec4b1` feat(tui): mark a blocked bucket on its bar; count Fable resets apart (#667) | CONFLICT | W3 | TUI blocked-bucket mark |
| `d76cb03` feat(routing): preserve manual account selection (#668) | CONFLICT | W3 | preserve manual account selection |
| `cbffc30` feat(usage): opt-in usage history per consumer, model and account in local SQLite (#665) | CONFLICT | SKIP | opt-in SQLite usage history; no consumer, new dependency surface |
| `28b2c0d` chore(ci): bump docker/login-action from 4.7.0 to 4.8.0 (#666) | CLEAN | W1 | CI action bump, SHA-pinned |
| `acaa750` Bump to 1.1.29 (#670) | CONFLICT | SKIP | version bump |
| `9bbfef9` fix(routing): a switch to an outranked account is reported as not taking effect under distributeSessions (#671) | CONFLICT | W3 | switch to an outranked account reported as not taking effect |
| `ec8c975` feat(activity): name the upstream error type on non-2xx request lines (#672) | CONFLICT | W3 | upstream error type on non-2xx lines |
| `fb40aed` fix: preserve client credentials for trusted-device enrollment (#673) | CONFLICT | W2 | client credentials kept for trusted-device enrollment |
| `43c07f7` switchOnSessionReset: option to keep traffic on a healthy account when another's 5h window resets (#686) (#687) | CONFLICT | W3 | switchOnSessionReset keeps traffic on a healthy account |
| `7d3afd8` fix(accounts): work in flight during a removal stays on the account it started on (#679) | CLEAN | W1 | in-flight work during a removal stays on its account |
| `6b21b3c` test: keep an exported TEAMROUTER_* variable from steering npm test into a real config (#680) | CONFLICT | W2 | exported TEAMROUTER_* cannot steer npm test into a real config (package.json conflict) |
| `5ae0c6d` fix(accounts): a removal renumbers each provider's cursor (#688) | CLEAN | W1 | removal renumbers each provider's cursor |
| `7a5805d` Hardening #4: fix(routing): the session-reset switch keeps the operator's manual choice (#682) | CONFLICT | W3 | Hardening #4: session-reset switch keeps the manual choice |
| `bddaaab` Hardening #6: fix(routing): the soonest-reset fallback and the warmer respect account cooldowns (#684) | CONFLICT | W2 | Hardening #6: soonest-reset fallback and warmer respect cooldowns (fork warmer, adapt) |
| `b0ee7ba` Hardening #1: fix(routing): a pinned request never fails over to a sibling (#678) | CONFLICT | W2 | Hardening #1: a pinned request never fails over to a sibling |
| `1d0cabc` Hardening #16: fix(storm): stormRamp values the ramp cannot pace fall back to their defaults (#703) | CONFLICT | W2 | Hardening #16: unpaceable stormRamp values fall back to defaults |
| `f20abf7` Hardening #5: fix(server): "every account refused" and "could not be renewed" count the accounts in play (#683) | CONFLICT | W2 | Hardening #5: refusal messages count the accounts in play |
| `f3e6742` Hardening #8: fix: upstream numbers are bounded (rate-limit limit, token-endpoint Retry-After, spend exponent) (#689) | CONFLICT | W2 | Hardening #8: upstream numbers bounded |
| `f7ef17a` Hardening #12: fix(accounts, sync): a token write carries only what it has (#699) | CONFLICT | W2 | Hardening #12: a token write carries only what it has |
| `b266547` fix(mitm): tunnel a host the presented leaf does not name (#698) | CONFLICT | W2 | MITM tunnels a host the presented leaf does not name; compare fork #50 SAN checkHost |
| `3019975` Hardening #9: docs: docs and comments say what the code does (#695) | CONFLICT | W3 | Hardening #9: docs match code |
| `ff5d2c4` fix(cli): config-changing commands update a fresh read under the config lock (#675, #691) (#704) | CONFLICT | W2 | config-changing CLI commands update a fresh read under the lock |
| `905fa4f` Hardening #15: fix(server): relays drop the headers the code says they drop (#700) | CONFLICT | W2 | Hardening #15: relays drop the headers they say they drop |
| `38fa86d` Hardening #13: fix(oauth): only the token endpoint's refusal marks a refresh token dead (#701) | CONFLICT | W2 | Hardening #13: only the token endpoint's refusal marks a refresh token dead (fewer false reauth asks) |
| `5d95d42` feat(resets): see and spend banked resets from the TUI (#690) | CONFLICT | W3 | TUI banked resets |
| `acc3537` Hardening #10: fix(sync): a removal stays removed across installs (#697) | CLEAN | W1 | Hardening #10: a removal stays removed across installs |
| `88ed28d` test(reload): count only this run's requests at the stub upstream (#705) | CLEAN | W1 | test isolation for reload |
| `607ecd2` Hardening #14: fix(server): bound the upstream answers the proxy held whole (#702) | CONFLICT | W2 | Hardening #14: bound upstream answers held whole (memory) |
| `1ffac30` feat(accounts): show when a refresh token expires, when the provider says (#674) (#706) | CONFLICT | W3 | show refresh-token expiry when the provider says |
| `cddc5ae` feat(routing): per-account endsAt, so an account about to end is drained first (#676) (#707) | CONFLICT | W3 | per-account endsAt drain; compare fork expiryRouting |
| `a02ce29` fix(resets): auto-redeem fires for an account parked at its weekly switch threshold (#685) (#708) | CONFLICT | W3 | auto-redeem banked reset at the weekly switch threshold |

## Next waves

- **W2** (teamclaude lane, Tue 2026-11-17): one PR per related group: hold (1a36775 + 143b514), drain (96e1255,
  closes DEFERRALS-11-07), client-key scope and control-plane (19a8fb9, 186ba30, 5040639), OAuth/reauth (38fa86d,
  e5f9eb5, 471b4f4, c17f0e7, fb40aed), probe (9563ecc + 3ff61c2 with a Settings entry), the Hardening series, MITM
  (b266547 against fork #50). Each: gate, one perturbation red, xreview, deploy via scripts/vm-restart-idle.sh.
- **W3** (teamclaude lane, Fri 2026-11-20): decide each: adapt, or move to SKIP with the reason here.
- Load-bearing fork pieces every pick must keep: dns-cache.js, graceful drain, expiryRouting, warm stagger,
  guarded removal, near-limit bucket lines, the Settings coverage test (see memory sync-2026-10-21-followups).
