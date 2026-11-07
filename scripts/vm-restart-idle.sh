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

ssh -o ConnectTimeout=5 "$HOST" "WAIT=$WAIT sh -s" <<'REMOTE'
set -eu
idle() {
  /opt/node/bin/node - <<'JS'
const fs = require('fs');
const key = JSON.parse(fs.readFileSync(process.env.HOME + '/.config/teamclaude.json', 'utf8')).proxy.apiKey;
fetch('http://127.0.0.1:3456/teamclaude/status', { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(5000) })
  .then(r => r.json())
  .then(d => process.exit(d.accounts.reduce((n, a) => n + (a.inFlight || 0), 0) === 0 ? 0 : 1))
  .catch(() => process.exit(2));
JS
}
i=0
while [ "$i" -lt "$WAIT" ]; do
  if idle; then
    sudo rc-service teamclaude restart >/dev/null 2>&1
    echo "restarted at 0 in-flight after ${i}s"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "never at 0 in-flight within ${WAIT}s; not restarted" >&2
exit 1
REMOTE
