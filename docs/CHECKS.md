# CHECKS

These are standing checks that run as durable systemd **user timers** on familiar. Each run prints one line:

```
CHECK <name> <ok|warn|fail> · <fact, number, time> · <next/owner>
```

JP asked for this on 2026-11-14 at 10:1x: "we should have more crons checking things clearly … I keep running into issues where data is stale or static". Every check below was added because something went wrong that nothing was watching. That incident is recorded in the check's row.

Where each line goes:
- **The journal.** Read it with `journalctl --user -u teamclaude-check-<name>`.
- **`~/.local/state/checks/<name>.line`.** This holds the latest line, written as `.tmp` then renamed: the fleet's canonical place (FOR-AGENTS rule 24), which Hearth › Checks and the 08:11 pass read.
- **`~/.local/state/checks/<name>.log`.** This keeps about 3 weeks of history.

How a run exits: always 0, whatever it found. A check reports, it never gates; `fail` is a line, not a failed unit.

**Daily line.** `~/.local/libexec/teamclaude-checks/summary.sh` prints every check that is not ok. It also prints a check whose last result is older than twice its cadence, or is not exactly one line of the full shape, because a stopped timer or a garbled result is itself a warn. When it prints nothing, every check is ok and fresh. The teamclaude lane copies its output into the daily line.

## The checks

| Name | Timer | Cadence | Measures | Owner | The miss behind it |
|---|---|---|---|---|---|
| `pool-quota` | `teamclaude-check-pool-quota.timer` | every 15 min (:00/:15/:30/:45) | `GET 127.0.0.1:3456/teamclaude/quota`: the pool's five-hour and weekly-shared remaining, the seats ≥90 % used, seats not active, and stale buckets | teamclaude lane | Lanes found out about an empty pool by hitting it. The quota numbers can also go stale without anyone noticing. |
| `proxy-wrapper` | `teamclaude-check-proxy-wrapper.timer` | every 5 min (:02/:07/…/:57; was 15 min until the 2026-11-15 outage) | On familiar, wakizashi and katana: whether `:3456` answers `/teamclaude/quota`, and whether `claude` fails closed | teamclaude lane | Before #66, the wrapper silently ran claude on the host's own login whenever `:3456` was down. That billed a seat outside the pool (Sen, 2026-11-14 06:4x). |
| `forge-keys` | `teamclaude-check-forge-keys.timer` | daily 07:20 | The forge gateway's (LiteLLM, ubox0) virtual keys: spend outside a key's allowlist, keys unused for 30 days, spend by unknown keys, and refused calls by inactive keys | teamclaude lane; gateway owned by palace-nemotron | The 2026-11-14 Ember key rotation. A key fragment leaked, and the only way to tell whether anyone tried the old key was a manual SQL read. |
| `fable-use` | `teamclaude-check-fable-use.timer` | daily 07:40 | `GET 127.0.0.1:3456/teamclaude/quota`: each seat's Fable weekly bucket (`buckets.weeklyFable`), its used % and when it resets | teamclaude lane | On 2026-11-16 every seat's Fable week stood at 0 % used. The proxy rations Fable to the `fable.allow` client keys (JP, 2026-10-11), so a whole week's Fable allowance can expire unused with nobody seeing it. This check is the mechanism for JP's "use down all credits" rule on this pool (Sen, 2026-11-16 08:0x). |
| `resets-banked` | `teamclaude-check-resets-banked.timer` | daily 07:45 | `GET 127.0.0.1:3456/teamclaude/quota` → `seats[].resets`: banked Claude usage-limit resets split weekly-clearing / 5h-only with each soonest expiry, and `resetsSpent7d` | teamclaude lane | On 2026-11-16 every seat's reset count read empty to the fleet lead (the field it looked at did not exist) and 5 of 7 seats' readings were 3–8 h stale behind 401s. A reset that expires unspent is lost, and the automatic reset strategy (JP, 2026-11-16 08:26) needs the count to be trusted. |

### pool-quota

- **warn:**
  - five-hour remaining is under 0.15;
  - weekly-shared remaining is at or under 0.15;
  - a seat bucket's `resetAt` is more than 15 minutes in the past and it still shows usage. The numbers have stopped updating; that is the stale data JP named.
- **fail:**
  - weekly-shared remaining is at or under 0.05;
  - the endpoint does not answer, or it answers with anything other than exactly one JSON document holding the aggregate numbers.
- **Why these weekly numbers:** they follow the dashboard's 7-day switch threshold (`switchThreshold.unified7d`). JP moved it from 0.90 to 1.00 on 2026-11-15 at 10:03 (log: `Switch threshold (unified7d) set to 100% via SSO as "jp"`), so seats are used to the end of their week. Under the old 0.30 floor the check would read WARN most of every week by construction. If the slider moves again, move these numbers with it.
- **Informational:**
  - The weekly reset (`aggregate.weeklyShared.nextResetAt`) is printed as `week resets <day> <mm-dd> <hh:mm>` whenever the proxy reports a sane one.
  - Seats at or above 90 % used (five-hour or weekly) are named by the local part of their address.
  - Seats that are not `active` are listed.
  - None of these causes a warn.
- **Example:** `CHECK pool-quota warn · 5h 63% left, week 12% left (week at or under 15%), week resets Mon 11-16 17:00, seats ≥90% used: claude3 jp claude2 claude4, at 10:45 · next run in 15 min · owner teamclaude lane`

### proxy-wrapper

- **What runs.** `proxy-probe.sh` runs on each host, locally or piped over `ssh <host> bash -s`. It prints `proxy=<code> wrapper=<state> claude=<running claude CLIs> direct=<those connected around the pool>`. The check requires the probe to exit 0 and to print exactly one well-formed line; anything else counts as unreachable.
- **The wrapper is judged by identity and never run.** Running an unknown `~/.cargo/bin/claude` could start a real session or change state. Instead, the probe compares the wrapper's sha256 with the reviewed wrapper (`scripts/claude-wrapper.sh` at the installed commit, which `install.sh` places beside the checks). The repo's tests prove that the reviewed wrapper exits 69 when its proxy is down.
- **Wrapper states:**
  - `refuses`: byte-identical to the reviewed wrapper.
  - `wrapper-<sha8>`: any other file, for example the pre-#66 wrapper that fell back to the host's own login.
  - `envsh-pool`: katana's case. There is no cargo wrapper, and the cc switcher's `env.sh` is **read, never run**. The probe walks its lines in order with byte semantics (`LC_ALL=C`, splitting on space and tab only, as bash does), applying each `unset` and each literal `export NAME=value`. The result leaves `HTTPS_PROXY` and/or `https_proxy` (Node reads the lowercase one first) exactly at `http://127.0.0.1:3456` or `https://<token>@10.0.6.145:3443`, with any other set one also at the pool. The value carries a client key, so it is compared in the probe and never printed.
  - `envsh-off`: `env.sh` leaves the proxy anywhere else, or unset.
  - `envsh-bypass`: the proxy is the pool, but `NO_PROXY`/`no_proxy` holds `*` or an entry that, by NO_PROXY host rules (equal or parent domain, the parent rule applied even without a leading `.` as curl does: claude here is a Bun binary and Node's narrower rule may not hold, so this errs toward a warn; a `:port` read first, and a numeric port other than 443 cannot match; `*` alone matches everything and a leading `*` matches any suffix (Node's rule); entries split on commas and blanks, and any other non-ASCII byte in the list makes the file unverifiable; case-insensitive; never expanded as a file name), matches a host claude calls: `api.anthropic.com`, `console.anthropic.com`, `statsig.anthropic.com`, `mcp-proxy.anthropic.com`, `claude.ai`. Those calls would skip the pool.
  - `envsh-unverifiable`: `env.sh` has a line other than a comment, `unset NAMES` or a literal `export NAME=value` (a conditional, a `$`, a substitution, a `source`, or an unquoted value bash would expand: braces, `~`, `*`, `?`, `[`), or it leaves one of `HTTPS_PROXY`, `https_proxy`, `NO_PROXY`, `no_proxy` to whoever runs claude. Either way its effect cannot be known from the file alone.
  - `none`: neither a wrapper nor `env.sh` exists.
- **What the running claude CLIs do.** The probe also finds every running claude CLI by its executable path (`…/claude/versions/…`, never by name) and reads its established connections with `ss`. Through the pool, every HTTPS call is a CONNECT to the forwarder (`127.0.0.1:3456`) or to the VM on the LAN. A claude process connected to a **public** address on port 443 is going around the pool, whatever PATH, wrapper or settings started it. This is what catches a shadowed PATH or a stray `--settings`. Reading `/proc/<pid>/environ` is not enough, because `~/.claude/settings.json` sets the proxy inside claude after it starts. Live control on 2026-11-14: a `curl` copied under a `claude/versions/` path, fetching a public URL, was counted (`direct=1`), and was no longer counted once it ended. If the connection listing itself fails, the probe reports `direct=unknown`, which warns; it never reads as 0.
- **fail:** this host's own forwarder does not answer, since familiar carries the fleet; or the reference wrapper is missing (reinstall).
- **warn:** a claude process is connected around the pool; another host's forwarder does not answer; a host is unreachable or its probe output is garbled; a host's wrapper is not the reviewed one or is not executable (`wrapper-notexec`; PATH would fall through to the native claude); its `env.sh` is unverifiable; or its `claude` could run outside the pool (`envsh-off`, `envsh-bypass`, `none`).
- **Example:** `CHECK proxy-wrapper ok · familiar :3456 200, wrapper refuses, 19 claude running; wakizashi :3456 200, wrapper refuses, 0 claude running; katana :3456 200, wrapper envsh-pool, 2 claude running, at 11:05 · next run in 5 min · owner teamclaude lane`

### forge-keys

- **What runs.** One read-only SELECT batch through `psql` inside `forge-db-1` on ubox0. The answer must reach its `END` marker and hold exactly one numeric `KEYS`, `UNKNOWN` and `REFUSED` row; every other row must be a well-formed `OUT` or `IDLE` row. A cut-off or malformed answer is a fail, never a clean result.
- **Aliases and model names are reduced to `[A-Za-z0-9._:/-]` in SQL**, with anything else replaced by `?`, so a `|` or a newline in an alias cannot break the row protocol. Rows are counted, not inferred from their text; an empty alias shows as `(no alias)`.
- **"Spent" and "used" mean `status = 'success'`.** LiteLLM also logs a refused call (a key denied a model) as a `failure` row. Before this rule, the check flagged two of our own denial probes as spend.
- **warn:**
  - in the last 30 days, a key spent on a model outside its allowlist (a key with an empty `models` list is unrestricted in LiteLLM and never counts);
  - a key older than 30 days has not been used in 30 days (a prune candidate);
  - a key that is not active, not deleted and not the master spent something in the last 7 days.
- **Informational:** refused calls by inactive keys in the last 7 days, and how many of those came from deleted keys. Someone trying a revoked key shows up here.
- **fail:** the database cannot be read, or its answer is incomplete.
- **Example:** `CHECK forge-keys ok · 12 active keys, none outside its allowlist, none idle 30 days, no unknown spenders, refused calls by inactive keys in 7 days: 11 (4 by deleted keys), at 10:18 · next run tomorrow 07:20 · owner teamclaude lane (gateway: palace-nemotron)`

### fable-use

- **Why daily, not weekly.** Each seat's Fable week ends at its own time (they differ by days), so one weekly run would miss most of them. The check judges each seat by its own `resetAt`.
- **warn:** a seat's Fable week ends within 24 hours and less than 1 % of it is used: that allowance is about to expire unused.
- **fail:** the endpoint does not answer, or it answers with anything other than exactly one JSON document holding an `accounts` list.
- **Informational:** the pool's average Fable use and each seat's, by the local part of its address; seats that report no Fable bucket. Disabled seats are left out.
- **What to do on a warn.** Use the named seats' Fable before the reset (a lane on a `fable.allow` key), or ask JP to widen `fable.allow`; the allow list is his rationing rule, so widening it is his word.
- **Example:** `CHECK fable-use warn · Fable week used: pool avg 0% (claude3 0%, jp 0%, claude 0%, claude2 0%, claude4 0%, claude5 0%, claude6 0%); ending unused within 24 h: claude3 jp claude4, at 08:02 · next run tomorrow 07:40 · owner teamclaude lane` (the first live run, 2026-11-16).

### resets-banked

- **The line** is the pass's reset count: `banked: weekly-clearing N (soonest expiry …), 5h-only M (soonest expiry …); spent in 7 days: K`. "Spent" counts every path (pool-dry, rule, operator), from each seat's saved spend times.
- **warn:** a seat holds a reset that expires within 48 hours unspent.
- **Fresh only:** a seat's reading counts only if its `seenAt` is under 2 hours old (the probe runs every 30 minutes). An older reading is named as stale, left out of the counts, and warns; if no seat is fresh, the check fails.
- **fail:** the endpoint does not answer or holds no valid `seats` list (a malformed `resets` block included), or no seat has a fresh reading (the probe is down; a stale count must not read as ok).
- **Informational:** seats without a reading are named.
- **Example:** `CHECK resets-banked ok · banked: weekly-clearing 2 (soonest expiry Dec 10), 5h-only 14 (soonest expiry Mar 9); spent in 7 days: 2, at 07:45 · next run tomorrow 07:45 · owner teamclaude lane`

## Install, update and rollback

Install only from a merged commit, never from a working tree:

```
scripts/checks/install.sh <commit on origin/master>
```

The script does the following:
1. Extracts every script, the reviewed `claude-wrapper.sh` and the units into a staging directory. It checks that each script is present and parses, and that `scripts/checks/systemd/` holds exactly the ten check units. A missing or extra file publishes nothing.
2. Takes an exclusive lock for the whole run (a second install is refused). Records which timers are running (an unreadable state refuses before anything stops). Stops the five timers, and refuses if one did not stop or its state cannot be read (an unreachable user manager is not "stopped"), and waits (up to 5 minutes) for any running check to finish, so no check runs while its files are half replaced. On any exit after the stop that is not a finished install (a refusal, a failed move, an unexpected error), all five timers are stopped first (a failed `enable --now` may have started some) and any running check is waited for; then every file already published is restored and systemd reloads it; then the timers that were running are started again, and only those. Every rollback step is checked: if a file cannot be restored or systemd cannot reload, the backups are kept and no timer is started; if the timers do not start again, the exact `systemctl --user start …` command is printed. If a timer did not stop or a check is still running after the wait, no file is replaced under it: the previous files are moved (one rename) to `~/.local/libexec/teamclaude-checks/.rollback-<time>/` with a `MANIFEST`, or, if that fails, left in the named staging directory; every timer stays stopped, and the install reports `ROLLBACK INCOMPLETE`.
3. Preflights the destinations (writable directories, existing targets are regular files), keeps a copy of each existing file, and moves the payload into place: scripts to `~/.local/libexec/teamclaude-checks/`, units to `~/.config/systemd/user/`. If any move fails, every file already moved is restored.
4. Reloads systemd.
5. Enables and starts exactly the five named timers.

To update, run it again with the newer commit. To roll back:

```
systemctl --user disable --now teamclaude-check-{pool-quota,proxy-wrapper,forge-keys,fable-use,resets-banked}.timer
```

## Adding a check

1. Add a script under `scripts/checks/` that sources `lib.sh` and ends in `check_emit`.
2. Add its `.service` and `.timer` under `scripts/checks/systemd/`.
3. Give it a case in `summary.sh` with its maximum age.
4. Add a row here, including the miss behind it.
5. Add tests in `test/checks.test.js`, and show one red perturbation per guard.
