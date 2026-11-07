#!/bin/sh
# Restart the teamclaude proxy in the ubox0 VM at a moment with 0 requests in
# flight (the deploy rule: restart only at 0 in-flight).
#
# The operator key never leaves the node process on the VM: node reads it from
# the config file itself, so it is never in argv, the environment or a shell
# variable, where `ps` on the VM would show it (2026-11-07: an inline check
# passed it as an argument). test/vm-restart-idle-script.test.js holds that.
#
# Usage: scripts/vm-restart-idle.sh [ssh-host] [max-wait-seconds]
set -eu
HOST=${1:-jp@10.0.6.145}
WAIT=${2:-300}
case $WAIT in ''|*[!0-9]*) echo "max-wait must be whole seconds" >&2; exit 64 ;; esac
if [ "${#WAIT}" -gt 4 ] || [ "$WAIT" -gt 3600 ]; then echo "max-wait is at most 3600" >&2; exit 64; fi

ssh -o ConnectTimeout=5 "$HOST" "WAIT=$WAIT sh -s" <<'REMOTE'
set -eu
idle() {
  /opt/node/bin/node - 2>/dev/null <<'JS'
// Exit 0 only on a proven idle proxy: an ok HTTP status, a non-empty account
// list and a non-negative whole inFlight on every account. Anything else
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
        n += a.inFlight;
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
    sudo rc-service teamclaude restart >/dev/null 2>&1
    echo "restarted at 0 in-flight"
    exit 0
  fi
  sleep 1
done
echo "never at 0 in-flight within ${WAIT}s; not restarted" >&2
exit 1
REMOTE
