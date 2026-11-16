#!/bin/sh
# Restart the teamclaude proxy in the ubox0 VM at a moment with 0 requests in
# flight (the deploy rule: restart only at 0 in-flight).
#
# The operator key never leaves the node process on the VM: node reads it from
# the config file itself, so it is never in argv, the environment or a shell
# variable, where `ps` on the VM would show it (2026-11-07: an inline check
# passed it as an argument). test/vm-restart-idle-script.test.js holds that.
#
# After the restart it proves the restart: the old node child (pid + start time, from OpenRC's
# child_pid record) is gone, a new child is recorded, and GET /teamclaude/quota answers 200 within
# 30 s. Exit 0 only then; 3 = restarted but not verified (the reason on stderr); 1 = never idle.
#
# JP's sittings (Sen 2026-11-16 11:4x): while JP is at the keys in a live session, a restart is refused.
# money's queue writes ~/.local/state/squire/sitting.active on this host (mtime = the sitting's start) and
# removes it when the sitting ends. A flag under 2 h old → print "JP sitting since <time>; retry later" and
# exit 75 (EX_TEMPFAIL: nothing restarted; 3 stays "restarted but not verified"). An older flag is stale
# and only warned about. Fail closed: a flag that cannot be looked up (an unsearchable directory), a
# symlink whose target cannot be read, or a start time in the future counts as a sitting.
# The flag is read before the idle wait and again after it, right before the restart: the VM side runs
# twice, PHASE=wait (exits once idle, restarts nothing) and then PHASE=restart (one idle check, no
# waiting: busy → exit 10, nothing done, and this host goes back to the wait phase and re-reads the
# flag). What remains between the last flag read and the restart is one ssh round trip plus the 1 s
# idle re-check.
# `--sitting` prints the flag's state and exits 0 (no sitting) or 75, restarting nothing (for the notice).
# TC_SITTING_OK=1 overrides, for an outage that the restart itself fixes; the override is printed.
#
# Usage: scripts/vm-restart-idle.sh [--sitting] [ssh-host] [max-wait-seconds]
set -eu
SITTING_FLAG=${TC_SITTING_FLAG:-$HOME/.local/state/squire/sitting.active}
SITTING_MAX=7200
# 0 only when the flag's absence is proved: its nearest existing ancestor is a searchable directory
absent() {
  p=$SITTING_FLAG
  while :; do
    p=$(dirname "$p")
    # a symlinked ancestor counts as existing; -d/-x follow it, so a dangling or unsearchable target fails
    if [ -e "$p" ] || [ -L "$p" ]; then [ -d "$p" ] && [ -x "$p" ]; return; fi
    case $p in /|.) return 1 ;; esac
  done
}
# 0 + "JP sitting since <time>" on stdout while a fresh flag exists (or it cannot be checked);
# 1 when there is provably none, or it is stale
sitting() {
  if ! [ -e "$SITTING_FLAG" ] && ! [ -L "$SITTING_FLAG" ]; then
    absent && return 1
    echo "JP sitting? (flag $SITTING_FLAG cannot be checked)"; return 0
  fi
  m=$(stat -L -c %Y "$SITTING_FLAG" 2>/dev/null) || m=""
  case $m in ''|*[!0-9]*) echo "JP sitting (flag $SITTING_FLAG present, start time unreadable)"; return 0 ;; esac
  age=$(( $(date +%s) - m ))
  if [ "$age" -ge "$SITTING_MAX" ]; then
    echo "stale sitting flag $SITTING_FLAG ($(( age / 60 )) min old, over 2 h) ignored" >&2
    return 1
  fi
  echo "JP sitting since $(date -d "@$m" '+%H:%M %Z')"
}
if [ "${1:-}" = --sitting ]; then
  if s=$(sitting); then echo "$s"; exit 75; fi
  echo "no JP sitting"; exit 0
fi
gate() {
  if s=$(sitting); then
    if [ "${TC_SITTING_OK:-}" = 1 ]; then
      echo "TC_SITTING_OK=1: restarting despite: $s" >&2
    else
      echo "$s; retry later (not restarted)" >&2
      exit 75
    fi
  fi
}
gate
HOST=${1:-jp@10.0.6.145}
WAIT=${2:-300}
case $WAIT in ''|*[!0-9]*) echo "max-wait must be whole seconds" >&2; exit 64 ;; esac
if [ "${#WAIT}" -gt 4 ] || [ "$WAIT" -gt 3600 ]; then echo "max-wait is at most 3600" >&2; exit 64; fi

# The VM side, fed on stdin: PHASE=wait waits up to WAIT s for idle and exits 0 (restarts nothing);
# PHASE=restart, after this host has re-read the sitting flag, checks idle once and restarts, or exits 10
# (busy again, nothing done) without waiting.
remote_body() {
  cat <<'REMOTE'
set -eu
PHASE=${PHASE:-restart}
# Test hooks (test/vm-restart-idle-script.test.js runs this body locally; never set on the VM):
# TC_IDLE_CMD, TC_RESTART_CMD, TC_CHILD_FILE, TC_PROC, TC_QUOTA_URL, TC_LISTENER_CMD, TC_VERIFY_WAIT, TC_STEP.
CHILD_FILE=${TC_CHILD_FILE:-/run/openrc/options/teamclaude/child_pid}
PROC=${TC_PROC:-/proc}
QUOTA_URL=${TC_QUOTA_URL:-http://127.0.0.1:3456/teamclaude/quota}
VERIFY_WAIT=${TC_VERIFY_WAIT:-30}
STEP=${TC_STEP:-1}
stat_of() { sed 's/^.*) //' "$PROC/$1/stat" 2>/dev/null; } # fields from 3 on: state is $1, start time $20
# "<pid>:<start time>" of the supervised node child (OpenRC's record + /proc), only while it is a live
# process (not a zombie or dead); else nothing
child() {
  p=$(cat "$CHILD_FILE" 2>/dev/null) || return 0
  case $p in ''|*[!0-9]*) return 0 ;; esac
  set -- $(stat_of "$p" | awk '{ print $1, $20 }')
  case ${1:-} in ''|Z|X|x) return 0 ;; esac
  [ -n "${2:-}" ] && echo "$p:$2"
  return 0
}
old_state() { # "<pid>:<start>" → alive | gone | unknown. gone needs proof: no /proc entry in a searchable
  # /proc, a different start time, or a zombie/dead state; a stat that cannot be read is unknown, never gone
  [ -n "$1" ] || { echo gone; return 0; }
  p=${1%%:*}
  [ -x "$PROC" ] || { echo unknown; return 0; }
  [ -e "$PROC/$p" ] || { echo gone; return 0; }
  set -- "$1" $(stat_of "$p" | awk '{ print $1, $20 }')
  [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo unknown; return 0; }
  case $2 in Z|X|x) echo gone; return 0 ;; esac
  if [ "$3" = "${1#*:}" ]; then echo alive; else echo gone; fi
  return 0
}
before_child() { # the pre-restart snapshot, three ways: "<pid>:<start>", "none" (proved: no record in a
  # searchable directory, or the recorded pid has no /proc entry), or "unknown" → the caller refuses
  dir=$(dirname "$CHILD_FILE")
  [ -x "$dir" ] && [ -r "$dir" ] || { echo unknown; return 0; }
  [ -e "$CHILD_FILE" ] || { echo none; return 0; }
  p=$(cat "$CHILD_FILE" 2>/dev/null) || { echo unknown; return 0; }
  case $p in ''|*[!0-9]*) echo unknown; return 0 ;; esac
  [ -x "$PROC" ] || { echo unknown; return 0; }
  [ -e "$PROC/$p" ] || { echo none; return 0; }
  # identity from the pid read above; the record must still name it afterwards (no mixing two children)
  set -- $(stat_of "$p" | awk '{ print $1, $20 }')
  case ${1:-} in ''|Z|X|x) echo unknown; return 0 ;; esac
  [ -n "${2:-}" ] && [ "$(cat "$CHILD_FILE" 2>/dev/null)" = "$p" ] || { echo unknown; return 0; }
  echo "$p:$2"
  return 0
}
owners() { # <seconds>: every pid listening on port 3456, any address, one per line ("?" when netstat
  # cannot name it), bounded by the time given (netstat names other users' sockets only as root). A lookup
  # that fails or times out returns 1 and prints nothing: partial output is never a listener set.
  [ "$1" -gt 0 ] || return 1
  if [ -n "${TC_LISTENER_CMD:-}" ]; then ns=$(timeout "$1" sh -c "$TC_LISTENER_CMD") || return 1; printf '%s\n' "$ns" | sed '/^$/d'; return 0; fi
  ns=$(timeout "$1" sudo -n netstat -tlnp 2>/dev/null) || return 1
  printf '%s\n' "$ns" | awk '$1 ~ /^tcp/ && $6 == "LISTEN" && $4 ~ /:3456$/ {
    split($7, b, "/"); print (b[1] ~ /^[0-9]+$/) ? b[1] : "?" }' | sort -u
  return 0
}
serving() { # <seconds>: the proxy itself answered the quota route within that time and curl finished:
  # 200, or the proxy's own 401 authentication_error (the VM has trustLoopback false; no key is sent,
  # none is needed to prove its event loop answers). A bare 401 from anything else does not count.
  out=$(curl -q -s -w '\n%{http_code}' --noproxy '*' --max-time "$1" "$QUOTA_URL" 2>/dev/null) || return 1
  code=$(printf '%s' "$out" | tail -n 1)
  [ "$code" = 200 ] && return 0
  [ "$code" = 401 ] && printf '%s' "$out" | grep -q '"type":"authentication_error"'
}
left() { # whole seconds before the deadline, capped at $1
  l=$(( end - $(date +%s) )); [ "$l" -gt "$1" ] && l=$1; echo "$l"
}
# 2026-11-15: a restart left the old node alive (wedged, ignoring SIGTERM); every new child died on
# "port in use" for 7.5 h while this script had already said "restarted". A restart is reported only
# when, inside VERIFY_WAIT: the old child is PROVED gone (or provably none existed), a new live child is
# recorded, it is the ONLY listener on :3456 (any address, so curl cannot reach someone else), the proxy
# answers within the time left, and after the answer the child record and the listener set are
# unchanged. Every observation is bounded by the time left; the reason on failure uses the last
# observations (nothing is probed after the deadline). Runs where set -e is suppressed: every step is
# explicit.
verify() {
  old=$1; end=$(( $(date +%s) + VERIFY_WAIT )); new=""; own=""; answered=no; ostate=unknown
  [ "$old" = none ] && old=""
  while :; do
    [ "$(left 3)" -gt 0 ] || break
    ostate=$(old_state "$old"); new=$(child)
    own=$(owners "$(left 3)") || own="? (listener lookup failed or timed out)"
    if [ "$ostate" = gone ] && [ -n "$new" ] && [ "$new" != "$old" ] && [ "$own" = "${new%%:*}" ]; then
      t=$(left 5); [ "$t" -gt 0 ] || break
      if serving "$t"; then
        answered=yes
        [ "$(left 3)" -gt 0 ] || break
        if [ "$(child)" = "$new" ] && own2=$(owners "$(left 3)") && [ "$own2" = "${new%%:*}" ] && [ "$(date +%s)" -le "$end" ]; then
          echo "restarted at 0 in-flight: old child ${old:-none on record} gone, new child $new alone on :3456 and serving"
          return 0
        fi
      else answered=no; fi
    fi
    [ "$(left "$STEP")" -gt 0 ] || break
    sleep "$(left "$STEP")"
  done
  why=""
  case $ostate in
    alive) why="old child $old is STILL ALIVE (holds the ports?)" ;;
    unknown) why="old child $old could not be checked (unreadable /proc entry)" ;;
  esac
  if [ -z "$new" ]; then why="${why:+$why; }no live new child recorded"
  elif [ "$new" = "$old" ]; then why="${why:+$why; }the child did not change"
  elif [ "$own" != "${new%%:*}" ]; then why="${why:+$why; }:3456 listeners are [$(echo $own)], not only the new child ${new%%:*}"
  elif [ "$answered" = no ]; then why="${why:+$why; }$QUOTA_URL did not answer 200 in time"; fi
  echo "RESTART NOT VERIFIED after ${VERIFY_WAIT}s: ${why:-the proof did not complete inside the deadline}" >&2
  return 3
}
idle() {
  if [ -n "${TC_IDLE_CMD:-}" ]; then sh -c "$TC_IDLE_CMD"; return; fi
  /opt/node/bin/node - 2>/dev/null <<'JS'
// Exit 0 only on a proven idle proxy: an ok HTTP status, a non-empty account
// list and a non-negative whole inFlight (and openStreams, when reported) on every account. Anything else
// (error status, bad JSON, missing or negative counters, timeout) exits 2,
// which the loop treats as "not idle" (xreview 2026-11-07).
// Everything inside one try: a bad config must exit 2 without printing (a JSON
// parse error can quote the file, key included).
try {
  const fs = require('fs');
  const key = JSON.parse(fs.readFileSync(process.env.HOME + '/.config/teamclaude.json', 'utf8')).proxy.apiKey;
  const port = Number(process.env.TC_STATUS_PORT || 3456);
  fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': key }, redirect: 'error', signal: AbortSignal.timeout(5000) })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(d => {
      const accounts = d && d.accounts;
      if (!Array.isArray(accounts) || accounts.length === 0) throw new Error('no accounts');
      let n = 0;
      for (const a of accounts) {
        if (!a || !Number.isInteger(a.inFlight) || a.inFlight < 0) throw new Error('bad inFlight');
        // openStreams: responses still being delivered (a stream until its last byte). inFlight alone
        // drops at the headers, so a gate on it restarted under live streams (2026-11-16). Absent on a
        // proxy older than the field (counted as 0 there); present but malformed is not idle.
        if (a.openStreams !== undefined && (!Number.isInteger(a.openStreams) || a.openStreams < 0)) throw new Error('bad openStreams');
        n += a.inFlight + (a.openStreams ?? 0);
      }
      process.exit(n === 0 ? 0 : 1);
    })
    .catch(() => process.exit(2));
} catch {
  process.exit(2);
}
JS
}
# A wall-clock deadline, not a loop count: one check can take up to 5 s.
deadline=$(( $(date +%s) + WAIT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  # Two zero readings a second apart, restart right after the second. This
  # narrows the check-then-act window; it cannot close it, because shutdown
  # closes connections rather than draining them (follow-up issue: drain on
  # SIGTERM). A request that lands in that gap is cut, as on any restart.
  if idle && sleep 1 && idle && [ "$(date +%s)" -lt "$deadline" ]; then
    if [ "$PHASE" = wait ]; then echo "idle"; exit 0; fi
    before=$(before_child)
    if [ "$before" = unknown ]; then
      echo "cannot identify the current child (unreadable $CHILD_FILE or /proc entry); not restarted, since the result could not be proved" >&2
      exit 3
    fi
    if [ -n "${TC_RESTART_CMD:-}" ]; then sh -c "$TC_RESTART_CMD" >/dev/null || true
    else sudo rc-service teamclaude restart >/dev/null 2>&1 || true; fi
    rc=0; verify "$before" || rc=$?
    exit "$rc"
  fi
  if [ "$PHASE" = restart ]; then echo "busy again at the restart moment; nothing done" >&2; exit 10; fi
  sleep 1
done
echo "never at 0 in-flight within ${WAIT}s; not restarted" >&2
exit 1
REMOTE
}
end=$(( $(date +%s) + WAIT ))
while :; do
  left=$(( end - $(date +%s) ))
  if [ "$left" -le 0 ]; then echo "never at 0 in-flight within ${WAIT}s; not restarted" >&2; exit 1; fi
  remote_body | ssh -o ConnectTimeout=5 "$HOST" "WAIT=$left PHASE=wait sh -s" >/dev/null || exit $?
  gate
  # the restart phase gets only the time left of max-wait (the VM re-checks it before restarting; the
  # proof after a restart keeps its own timeout). max-wait bounds the patience for an idle moment, not a
  # safety property: the VM starts its clock when its shell starts, so a restart can land up to one ssh
  # setup (seconds) past it. The sitting flag is re-read before every restart phase regardless.
  left=$(( end - $(date +%s) ))
  if [ "$left" -le 0 ]; then echo "idle only at the deadline (${WAIT}s); not restarted" >&2; exit 1; fi
  rc=0; remote_body | ssh -o ConnectTimeout=5 "$HOST" "WAIT=$left PHASE=restart sh -s" || rc=$?
  [ "$rc" = 10 ] || exit "$rc"
done
