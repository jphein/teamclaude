# Mythos as a model family, and Fable/Mythos settings in the web GUI

Date: 2026-10-20. Asked by JP ("we need to add mythos support to teamclaude … and fable, and expose some good settings for them in teamclaude webgui"), relayed by jp-58.

## What was measured first (familiar, 2026-10-20 14:25–14:45 PDT)

1. **The picker is not teamclaude's doing.** Claude Code fills `/model` from `GET /api/model_selector/code` on the API host, sent with OAuth. teamclaude forwards that path with a rotated account token. I asked all five accounts directly (through the `/tc-acct/<name>/` pin). Every one returns the same catalog for org 35fb5e17. `claude-mythos-5-1` is in it, but in the `overflow` section, while `claude-fable-5-1` is in `main`. So Mythos sits under the picker's overflow list on every account; nothing is filtered or rewritten. Raw catalogs: `scratch/mythos/selector-*.json`.
2. **Mythos is served.** A Claude Code-shaped request for `claude-mythos-5-1` pinned to claude4 got a 200 and `"model":"claude-mythos-5-1"`. Its rate-limit headers were the same as an Opus request's: the shared `5h` and `7d` only, with no Mythos-specific `7d_*` bucket. The usage endpoint's learned family buckets (`quota.scopedWeekly`) list only `fable` on every account. Mythos has no separate weekly allowance today.
3. **The lead's Fable misfire has two causes, and neither is the allow list.**
   - `~/.claude/settings.json` on familiar sets `HTTPS_PROXY=http://127.0.0.1:3456` (no key) in its `env` block. Claude Code applies that over the process environment, so a lane that exports a keyed `HTTPS_PROXY` is overridden. Measured: `jp-92.env` sourced before `claude -p` left `clients.jp-92` absent.
   - Through familiar's forwarder, the documented `http://<key>@host` form (key as the Basic username only) gets familiar's key added as the password. The proxy tries the password slot first, so the caller becomes "familiar".
   - What works today, measured: `claude --settings <0600 file>` whose `env` holds `HTTPS_PROXY=http://<key>:<key>@127.0.0.1:3456`. `clients.jp-92.requests` went 1 → 15 → 29. A Fable request from it logged no rewrite.

## Design

### Families
`model.js` learns `mythos`: `modelFamily()` returns `'mythos'` for `/mythos/i`, before the Opus/Sonnet tests. There is no dedicated quota field, because upstream has none. The existing learned-bucket path (`_scopedWeekly` keyed by family) gates Mythos automatically on the day the usage endpoint starts reporting a `mythos` bucket, and the status display shows it as soon as it exists.

### Rationing generalised (`family-policy.js`)
`fable-policy.js` becomes one instance of a per-family policy. `family-policy.js` holds the shared machinery:
- `FAMILIES = { mythos, fable }`, each with a predicate and a default fallback (`claude-opus-5-5`).
- `familyPolicy(config, family)` reads `config[family] = { allow, model, fallbackOnCapacity }`.
- `rewriteFamilyBody(body, family, to, …)` is today's `rewriteFableBody` with the predicate as a parameter. Same canonicalisation, same refusal rules.
- `FamilyStats`: today's counters, plus rewrites per client over the last 24 h (hourly buckets, in memory).

`fable-policy.js` keeps its exports as thin wrappers, so the existing tests and call sites are unchanged.

Semantics are Fable's, unchanged, for both families:
- No `allow` list means rationing is off. An empty list means nobody. `"(shared key)"` admits key-less callers.
- A client not on the list has its request **rewritten, never refused**.
- An allowed client falls back when no account can serve the family. It also falls back on 529, unless `fallbackOnCapacity: false` (new, default true).
- The fallback model must not be of the same family. Mythos may fall back to a Fable model: policies run **Mythos first, then Fable**, so a Mythos request rewritten to Fable is then judged by Fable's list.
- The per-attempt final gate checks the exact bytes of every upstream attempt for every family that was ruled out.

### Entitlement: skip accounts that cannot serve a family
All accounts can serve Mythos today. This is for the day one can't. Suppose a request for a rationed family (Mythos or Fable) gets a 403 `permission_error` or a 404 `not_found_error` whose message names the model, with no rate-limit headers. Then:
- that account is marked `familyDenied[family]` for 6 h;
- `unavailableReason` returns `'family-denied'` for that family only;
- the request moves to another account.

If no account is left and the family policy has a fallback, it falls back exactly like the 529 path. A family refusal never reaches the account-wide `entitlement` cooldown, which would bench an account for Opus too.

### Status JSON
`GET /teamclaude/status` keeps `fable` in its current shape and adds `byClient24h: { <client>: n }`. It also adds `mythos` in the same shape. Per account, `quota.scopedWeekly` already carries any learned Mythos bucket, and `familyDenied` is added.

### Web GUI (Settings view, #21)
- A new field type, `clients`: checkboxes for every `proxy.clientKeys` name plus `(shared key)`. The settings endpoint sends **names only, never keys**. Unknown names already in the config stay listed, checked.
- The **Fable** group: Allowed clients (`clients`), Fallback model, Fall back when at capacity (`bool`).
- A new **Mythos** group with the same three fields.
- A read-only **Fable & Mythos** panel: per account, the Fable weekly allowance (`unified7dFable`), the Mythos weekly allowance (the learned `scopedWeekly.mythos`, or "shares the weekly bucket" when absent), and any family denial. Below that, rewrites and fallbacks in the last 24 h per client, for each family.

### Lanes presenting their own key (the lead fix) — docs, not code
`docs/usage.md` gets a section, *Presenting a client key from familiar*:
- Write a 0600 settings file with `env.HTTPS_PROXY = http://<key>:<key>@127.0.0.1:3456` (same for `https_proxy`, `HTTP_PROXY`, `http_proxy`).
- Launch with `claude --settings <file> …`.
- Explain why: the global settings `env` override, and the forwarder filling an empty password.

For the spire lead: `claude --settings ~/.config/teamclaude-client/jp-92.settings.json --resume …` (the file exists, 0600). No proxy or forwarder code changes. The password-first order is load-bearing for the forwarder's account-pin form `Basic <acct>:<key>`.

### Proposal only: should "familiar" be on `fable.allow`?
No. "familiar" is every key-less lane on the host, about 10.7K Fable requests a day by jp-58's count. Allowing it would spend the fleet's Fable allowance on every agent. JP's intent ("you and my claudes") is better served by giving JP's own sessions and the lead their own keys via `--settings`, which now works.

## Tests (fake upstream, `node --test`)
- `modelFamily('claude-mythos-5-1') === 'mythos'`; Mythos gates on a learned `scopedWeekly.mythos`.
- Mythos rationing: a non-allowed client is rewritten (never refused), an allowed one passes. An allowed one falls back when every account is family-denied, and on 529 only when `fallbackOnCapacity` is true. Mythos → Fable fallback is then subject to Fable's list.
- Family refusal: a 403 permission_error naming the model marks only that family on that account, the retry lands on another account, and an Opus request still uses the denied account.
- Settings: `clients` options carry names only (no key material anywhere in the payload); validation; `docs/configuration.md` coverage.
- One perturbation goes red: dropping the Mythos entry from the final per-attempt gate must fail the "modelMap maps back to Mythos" test.

## Not in scope
- Changing which client identity a request gets (proxy auth order, forwarder).
- Promoting Mythos into the picker's `main` section (Anthropic's catalog).
