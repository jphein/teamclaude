# CHECKS

These are standing checks that run as durable systemd **user timers** on familiar. Each run prints one line:

```
CHECK <name> <ok|warn|fail> · <fact, number, time> · <next/owner>
```

JP asked for this on 2026-11-14 at 10:1x: "we should have more crons checking things clearly … I keep running into issues where data is stale or static". Every check below was added because something went wrong that nothing was watching. That incident is recorded in the check's row.

Where each line goes:
- **The journal.** Read it with `journalctl --user -u teamclaude-check-<name>`.
- **`~/.local/state/checks/<name>.last`.** This holds the latest line.
- **`~/.local/state/checks/<name>.log`.** This keeps about 3 weeks of history.

How a run exits:
- `ok` and `warn` exit 0.
- `fail` exits 1, so the unit also shows up in `systemctl --user --failed`.

**Daily line.** `~/.local/libexec/teamclaude-checks/summary.sh` prints every check that is not ok. It also prints a check whose last result is older than twice its cadence, or is not exactly one line of the full shape, because a stopped timer or a garbled result is itself a warn. When it prints nothing, every check is ok and fresh. The teamclaude lane copies its output into the daily line.

## The checks

| Name | Timer | Cadence | Measures | Owner | The miss behind it |
|---|---|---|---|---|---|
| `pool-quota` | `teamclaude-check-pool-quota.timer` | every 15 min (:00/:15/:30/:45) | `GET 127.0.0.1:3456/teamclaude/quota`: the pool's five-hour and weekly-shared remaining, the seats ≥90 % used, seats not active, and stale buckets | teamclaude lane | Lanes found out about an empty pool by hitting it. The quota numbers can also go stale without anyone noticing. |
| `proxy-wrapper` | `teamclaude-check-proxy-wrapper.timer` | every 15 min (:07/:22/:37/:52) | On familiar, wakizashi and katana: whether `:3456` answers `/teamclaude/quota`, and whether `claude` fails closed | teamclaude lane | Before #66, the wrapper silently ran claude on the host's own login whenever `:3456` was down. That billed a seat outside the pool (Sen, 2026-11-14 06:4x). |
| `forge-keys` | `teamclaude-check-forge-keys.timer` | daily 07:20 | The forge gateway's (LiteLLM, ubox0) virtual keys: spend outside a key's allowlist, keys unused for 30 days, spend by unknown keys, and refused calls by inactive keys | teamclaude lane; gateway owned by palace-nemotron | The 2026-11-14 Ember key rotation. A key fragment leaked, and the only way to tell whether anyone tried the old key was a manual SQL read. |

### pool-quota

- **warn:**
  - five-hour remaining is under 0.15;
  - weekly-shared remaining is under 0.30;
  - a seat bucket's `resetAt` is more than 15 minutes in the past and it still shows usage. The numbers have stopped updating; that is the stale data JP named.
- **fail:** the endpoint does not answer, or it answers with anything other than exactly one JSON document holding the aggregate numbers.
- **Informational:** seats at or above 90 % used (five-hour or weekly) are named by the local part of their address, and seats that are not `active` are listed. Neither causes a warn.
- **Example:** `CHECK pool-quota warn · 5h 71% left, week 29% left (week under 30%), seats ≥90% used: claude3 jp claude2 claude4, at 10:17 · next run in 15 min · owner teamclaude lane`

### proxy-wrapper

- **What runs.** `proxy-probe.sh` runs on each host, locally or piped over `ssh <host> bash -s`. It prints `proxy=<code> wrapper=<state>`. The check requires the probe to exit 0 and to print exactly one well-formed line; anything else counts as unreachable.
- **The wrapper is judged by identity and never run.** Running an unknown `~/.cargo/bin/claude` could start a real session or change state. Instead, the probe compares the wrapper's sha256 with the reviewed wrapper (`scripts/claude-wrapper.sh` at the installed commit, which `install.sh` places beside the checks). The repo's tests prove that the reviewed wrapper exits 69 when its proxy is down.
- **Wrapper states:**
  - `refuses`: byte-identical to the reviewed wrapper.
  - `wrapper-<sha8>`: any other file, for example the pre-#66 wrapper that fell back to the host's own login.
  - `envsh-pool`: katana's case. There is no cargo wrapper, and the cc switcher's `env.sh` is **read, never run**. The probe walks its lines in order with byte semantics (`LC_ALL=C`, splitting on space and tab only, as bash does), applying each `unset` and each literal `export NAME=value`. The result leaves `HTTPS_PROXY` and/or `https_proxy` (Node reads the lowercase one first) exactly at `http://127.0.0.1:3456` or `https://<token>@10.0.6.145:3443`, with any other set one also at the pool. The value carries a client key, so it is compared in the probe and never printed.
  - `envsh-off`: `env.sh` leaves the proxy anywhere else, or unset.
  - `envsh-bypass`: the proxy is the pool, but `NO_PROXY`/`no_proxy` holds `*` or an entry that, by NO_PROXY host rules (equal or parent domain; an exact leading `.` or `*.` dropped; an explicit port must be 443; entries split on commas and blanks; case-insensitive; never expanded as a file name), matches a host claude calls: `api.anthropic.com`, `console.anthropic.com`, `statsig.anthropic.com`, `mcp-proxy.anthropic.com`, `claude.ai`. Those calls would skip the pool.
  - `envsh-unverifiable`: `env.sh` has a line other than a comment, `unset NAMES` or a literal `export NAME=value` (a conditional, a `$`, a substitution, a `source`, or an unquoted value bash would expand: braces, `~`, `*`, `?`, `[`), or it leaves one of `HTTPS_PROXY`, `https_proxy`, `NO_PROXY`, `no_proxy` to whoever runs claude. Either way its effect cannot be known from the file alone.
  - `none`: neither a wrapper nor `env.sh` exists.
- **fail:** this host's own forwarder does not answer, since familiar carries the fleet; or the reference wrapper is missing (reinstall).
- **warn:** another host's forwarder does not answer; a host is unreachable or its probe output is garbled; a host's wrapper is not the reviewed one or is not executable (`wrapper-notexec`; PATH would fall through to the native claude); its `env.sh` is unverifiable; or its `claude` could run outside the pool (`envsh-off`, `envsh-bypass`, `none`).
- **Example:** `CHECK proxy-wrapper ok · familiar :3456 200, wrapper refuses; wakizashi :3456 200, wrapper refuses; katana :3456 200, wrapper envsh-pool, at 10:25 · next run in 15 min · owner teamclaude lane`

### forge-keys

- **What runs.** One read-only SELECT batch through `psql` inside `forge-db-1` on ubox0. The answer must reach its `END` marker and hold exactly one numeric `KEYS`, `UNKNOWN` and `REFUSED` row; every other row must be a well-formed `OUT` or `IDLE` row. A cut-off or malformed answer is a fail, never a clean result.
- **Aliases and model names are reduced to `[A-Za-z0-9._:/-]` in SQL**, with anything else replaced by `?`, so a `|` or a newline in an alias cannot break the row protocol. Rows are counted, not inferred from their text; an empty alias shows as `(no alias)`.
- **"Spent" and "used" mean `status = 'success'`.** LiteLLM also logs a refused call (a key denied a model) as a `failure` row. Before this rule, the check flagged two of our own denial probes as spend.
- **warn:**
  - in the last 30 days, a key spent on a model outside its allowlist;
  - a key older than 30 days has not been used in 30 days (a prune candidate);
  - a key that is not active, not deleted and not the master spent something in the last 7 days.
- **Informational:** refused calls by inactive keys in the last 7 days, and how many of those came from deleted keys. Someone trying a revoked key shows up here.
- **fail:** the database cannot be read, or its answer is incomplete.
- **Example:** `CHECK forge-keys ok · 12 active keys, none outside its allowlist, none idle 30 days, no unknown spenders, refused calls by inactive keys in 7 days: 11 (4 by deleted keys), at 10:18 · next run tomorrow 07:20 · owner teamclaude lane (gateway: palace-nemotron)`

## Install, update and rollback

Install only from a merged commit, never from a working tree:

```
scripts/checks/install.sh <commit on origin/master>
```

The script does the following:
1. Extracts every script, the reviewed `claude-wrapper.sh` and the units into a staging directory. It checks that each script is present and parses, and that `scripts/checks/systemd/` holds exactly the six check units. A missing or extra file publishes nothing.
2. Preflights the destinations (writable directories, existing targets are regular files), keeps a copy of each existing file, and moves the payload into place: scripts to `~/.local/libexec/teamclaude-checks/`, units to `~/.config/systemd/user/`. If any move fails, every file already moved is restored.
3. Reloads systemd.
4. Enables and starts exactly the three named timers.

To update, run it again with the newer commit. To roll back:

```
systemctl --user disable --now teamclaude-check-{pool-quota,proxy-wrapper,forge-keys}.timer
```

## Adding a check

1. Add a script under `scripts/checks/` that sources `lib.sh` and ends in `check_emit`.
2. Add its `.service` and `.timer` under `scripts/checks/systemd/`.
3. Give it a case in `summary.sh` with its maximum age.
4. Add a row here, including the miss behind it.
5. Add tests in `test/checks.test.js`, and show one red perturbation per guard.
