#!/usr/bin/env bash
# CHECK proxy-wrapper: on each client host, the local teamclaude forwarder answers (:3456 serves
# /teamclaude/quota) and `claude` cannot run outside the pool (docs/CHECKS.md). Every 15 minutes.
#   fail: this host's own forwarder does not answer (familiar carries the fleet)
#   warn: another host's forwarder does not answer, a host is unreachable, or a host's claude would
#         run on its own login (wrapper runs-rc*, envsh-off, none)
# Inputs (tests): CHECK_HOSTS (default "familiar wakizashi katana"), CHECK_PROBE (a command that
# takes the host name and prints the probe line; default: run proxy-probe.sh locally or over ssh).
set -uo pipefail
here=$(dirname "$0")
. "$here/lib.sh"
NAME=proxy-wrapper
NEXT="next run in 15 min · owner teamclaude lane"
self=$(hostname -s 2>/dev/null || echo localhost)
# the reviewed wrapper (installed beside these scripts from the same merged commit): a host's
# ~/.cargo/bin/claude must be byte-identical to it
ref=${CHECK_WRAPPER_REF:-$here/claude-wrapper.sh}
[ -f "$ref" ] || ref="$here/../claude-wrapper.sh"   # running from the repo: scripts/claude-wrapper.sh
want=$(sha256sum "$ref" 2>/dev/null | cut -d' ' -f1)
[ -n "$want" ] || check_emit "$NAME" fail "reference wrapper $ref missing; reinstall the checks, at $(check_now)" "$NEXT"
probe() {
  if [ -n "${CHECK_PROBE:-}" ]; then $CHECK_PROBE "$1" "$want"; return; fi
  if [ "$1" = "$self" ]; then bash "$here/proxy-probe.sh" "$want"
  else timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=8 "$1" bash -s -- "$want" < "$here/proxy-probe.sh"; fi
}
status=ok; parts=(); bad=()
for h in ${CHECK_HOSTS:-familiar wakizashi katana}; do
  # the probe must exit 0 AND print exactly one well-formed line
  out=$(probe "$h" 2>/dev/null); prc=$?
  if [ "$prc" != 0 ] || [[ ! "$out" =~ ^proxy=([0-9]{3})\ wrapper=([a-z0-9-]+)\ claude=([0-9]+)\ direct=([0-9]+)$ ]]; then
    parts+=("$h unreachable"); bad+=("$h unreachable"); [ "$h" = "$self" ] && status=fail || { [ "$status" = fail ] || status=warn; }
    continue
  fi
  code=${BASH_REMATCH[1]} state=${BASH_REMATCH[2]} ncl=${BASH_REMATCH[3]} direct=${BASH_REMATCH[4]}
  p="$h :3456 $code, wrapper $state, $ncl claude running"; parts+=("$p")
  if [ "$direct" != 0 ]; then bad+=("$h $direct claude processes connected around the pool"); [ "$status" = fail ] || status=warn; fi
  if [ "$code" != 200 ]; then
    bad+=("$h forwarder $code")
    if [ "$h" = "$self" ]; then status=fail; else [ "$status" = fail ] || status=warn; fi
  fi
  case $state in
    refuses|envsh-pool) ;;
    wrapper-*) bad+=("$h ~/.cargo/bin/claude is not the reviewed wrapper ($state)"); [ "$status" = fail ] || status=warn ;;
    envsh-unverifiable) bad+=("$h env.sh cannot be read without running it"); [ "$status" = fail ] || status=warn ;;
    envsh-bypass) bad+=("$h env.sh NO_PROXY lets claude skip the pool"); [ "$status" = fail ] || status=warn ;;
    *) bad+=("$h claude can run outside the pool ($state)"); [ "$status" = fail ] || status=warn ;;
  esac
done
fact=$(IFS=';'; echo "${parts[*]}" | sed 's/;/; /g')
[ ${#bad[@]} -gt 0 ] && fact="$(IFS=';'; echo "${bad[*]}" | sed 's/;/; /g') — $fact"
check_emit "$NAME" "$status" "$fact, at $(check_now)" "$NEXT"
