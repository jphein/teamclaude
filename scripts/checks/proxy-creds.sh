#!/usr/bin/env bash
# CHECK proxy-creds: no teamclaude client key in a proxy URL on any client host (docs/CHECKS.md). Hourly.
# Design (Flow 0d1ee709, 2026-11-17): each client host runs a loopback forwarder that holds its key in
# one 0600 file; HTTPS_PROXY is http://127.0.0.1:3456 with no userinfo, so no tool's error text can
# print the key. katana's env.sh had https://<key>@VM and a git error printed it into a transcript
# (21:14, rotated under Flow 438265ac). This check keeps the design true:
#   fail: a host's config sets a proxy URL with userinfo (env.sh, ~/.claude/settings*.json, shell rc,
#         environment.d, user units), a process there still carries one in its environment, or cc's
#         teamclaude-remote.env exists (`cc teams` would write its key back into env.sh)
#   warn: a host could not be read (off, asleep or ssh refused): it is named, never counted as clean
# Prints paths, counts and process names only, never a value.
# Inputs (tests): CHECK_PROXY_CREDS_HOSTS (default below; "local" = this host without ssh),
#                 HOME and CHECK_PROC_DIR (passed to the local probe).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME=proxy-creds
NEXT="next run in 1 h · owner teamclaude lane"
probe="$(dirname "$0")/proxy-creds-probe.sh"
hosts=${CHECK_PROXY_CREDS_HOSTS:-local katana wakizashi serialhub gpu0 gpu1}
bad=(); unread=(); clean=()
for h in $hosts; do
  if [ "$h" = local ]; then
    out=$(bash "$probe" 2>/dev/null)
    label=$(hostname -s 2>/dev/null || echo local)
  else
    out=$(timeout 30 ssh -T -o BatchMode=yes -o ConnectTimeout=8 "$h" 'bash -s' < "$probe" 2>/dev/null)
    label=$h
  fi
  label=$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '?')
  if [ "$(printf '%s\n' "$out" | tail -n 1)" != END ]; then unread+=("$label"); continue; fi
  found=$(printf '%s\n' "$out" | awk '
    $1 == "FILE"   { f = f (f ? ", " : "") $2 }
    $1 == "REMOTE" { r = "cc remote.env present" }
    $1 == "PROC"   { p = $2 " process(es) (" $3 ")" }
    END { s = f; if (r) s = s (s ? "; " : "") r; if (p) s = s (s ? "; " : "") p; print s }' | LC_ALL=C tr -c 'A-Za-z0-9._,;:()/ ?\n\303\227-' '?')
  if [ -n "$found" ]; then bad+=("$label: $found"); else clean+=("$label"); fi
done
if [ ${#bad[@]} -gt 0 ]; then
  fact="key in a proxy URL on ${#bad[@]} host(s): $(IFS='|'; printf '%s' "${bad[*]}" | sed 's/|/ | /g')"
  [ ${#unread[@]} -gt 0 ] && fact="$fact; unread: ${unread[*]}"
  check_emit "$NAME" fail "$fact, at $(check_now)" "point the proxy at http://127.0.0.1:3456 (the host's forwarder), restart those processes, rotate the key if it was printed · owner teamclaude lane"
elif [ ${#unread[@]} -gt 0 ]; then
  check_emit "$NAME" warn "no key in a proxy URL on ${clean[*]:-none}; could not read ${unread[*]}, at $(check_now)" "$NEXT"
else
  check_emit "$NAME" ok "no key in a proxy URL on ${#clean[@]} hosts (${clean[*]}), at $(check_now)" "$NEXT"
fi
