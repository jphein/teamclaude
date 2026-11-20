# No proxy credential in env.sh — design (Flow row 0d1ee709)

**Status:** built on all six client hosts 2026-11-17 21:38; the two mechanisms that keep it true are open PRs
(listed under "What keeps it true"). **Ordered by** Sen 2026-11-17 21:16 after the katana leak (row 438265ac).

## Why

Until 2026-11-17, katana's `~/.config/claude-code/env.sh` exported `HTTPS_PROXY=https://<client key>@<VM>:3443`.
env.sh is sourced into every shell, so the key sat in every process environment on the host, and any tool that prints
its proxy URL in an error (curl, pip, npm, Node's fetch) could write it into a transcript, a log or the palace. That
happened: the katana key reached transcripts on 11-08, 11-09 and 11-17, and was rotated 2026-11-18 14:41.

Putting the key in the URL bought nothing: **Claude Code never sends `Proxy-Authorization` on CONNECT**, whatever the
URL holds (captured 2026-11-06), so the proxy could not have read it from there anyway.

## Design

1. **Each client host runs its own forwarder** on `127.0.0.1:3456` (`systemctl --user teamclaude-forwarder`, from
   ubox0 #78). It accepts plain HTTP on loopback with no auth, opens TLS to the VM's listener (`10.0.6.145:3443`,
   trusting the VM CA bundle alone, `servername: ''`), and adds `Proxy-Authorization` with the host's own key.
2. **The key lives in one file**: `~/.config/teamclaude-forwarder.key`, mode 0600, read by the forwarder only. The
   vault holds the same value under the host's item (`teamclaude clientKey <host>`); rotation is add-next, switch,
   needle the old value, update the item, revoke.
3. **Every proxy setting a process sees is the loopback form**: `HTTPS_PROXY=http://127.0.0.1:3456` (and the
   lower-case and HTTP_ twins), or `ANTHROPIC_BASE_URL=http://localhost:3456` in reverse mode. No userinfo, ever, in
   env.sh, `~/.claude/settings.json` env, a lane's `--settings` file or a systemd unit.
4. **One key per host** (katana, jp-wakizashi, serialhub, gpu0, gpu1; familiar's own). The proxy counts requests per
   client, so a leak is traced to one host and revoked without touching the others.

Loopback without auth is safe because the forwarder binds `127.0.0.1` only: a process that can reach it already runs
as a user on the host, and the same user can read the 0600 key file anyway.

## What changed on each host (2026-11-17)

| Host | Before | After |
|---|---|---|
| katana | env.sh `https://<key>@VM:3443`; `teamclaude-remote.env` | env.sh loopback; remote.env renamed `.retired-20261117-loopback` |
| wakizashi | settings.json proxy URL with userinfo | userinfo dropped (proof: `jp-wakizashi` counter 1006 → 1017) |
| familiar, serialhub, gpu0, gpu1 | already loopback | unchanged |

Proof at the time: the key appears in 0 process environments on 5 hosts (wakizashi was measured through its
settings and counter).

## What keeps it true

- **claude-code-switcher PR 11 (row d3d3cc19):** `cc teamclaude` no longer rewrites the loopback URL to
  `scheme://<key>@remote`; it strips any URL userinfo, ignores a leftover `teamclaude-remote.env` (except `TC_CA`,
  a path) and probes the local forwarder in `cc check`. Its test runs in a throwaway HOME and was red on master.
- **teamclaude PR 94, CHECK proxy-creds (hourly, all client hosts):** fails when a client key shows in any proxy URL,
  any process environment or a `teamclaude-remote.env`; the line names hosts and places, never the value.
- **CHECK memory-secrets (daily 06:50)** already scans memory files, skills and CLAUDE.md for vault values.

## Not covered

- A tool given the key on purpose (the dashboard launcher's `service.key`, the VM's own config) is out of scope:
  those are files, not environments.
- A host that is off (wakizashi since 2026-11-19 ~22:00) is not measured until it is back; proxy-creds reports it
  unreachable rather than clean.
