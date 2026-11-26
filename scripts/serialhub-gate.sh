#!/usr/bin/env bash
# Run the gate on a lane host, never on the machine the fleet's agents live on: the full suite at a load of
# 12–15 on familiar timed out files and flaked timing tests (rows 52cff50c, f9776f22), so every full `npm
# test`, `scripts/gate.sh` and perturbation run goes to serialhub (row 8aa26057, the lead 2026-11-24 17:1x).
#
# usage: scripts/serialhub-gate.sh <commit|branch> [-- <command>]
#   The commit must be pushed to the gate repo (default: the fork on GitHub). On the host, a dedicated clone
#   (not a synced tree) is fetched, checked out detached at that commit, cleaned of everything untracked but
#   node_modules, dependencies installed as CI does (no install scripts), and <command> run in it under
#   ionice/nice. <command> defaults to `bash scripts/gate.sh origin/master`. Its stdin is this script's
#   stdin, so `-- 'sh -s' < perturb.sh` runs a local perturbation script in the clone. Exit = <command>'s.
#   22: a bad ref or usage; any other failure before <command> runs exits non-zero with a message.
# Env: TC_GATE_HOST (serialhub), TC_GATE_SSH (ssh -o BatchMode=yes), TC_GATE_REPO (the fork's https URL),
#   TC_GATE_DIR (srv/wt/teamclaude-gate, under the host's $HOME), TC_GATE_NODE (22: the node major taken
#   from mise on the host when installed there; otherwise the host's node, which must be 20 or later).
set -u
usage() { echo "usage: scripts/serialhub-gate.sh <commit|branch> [-- <command>]" >&2; exit 22; }
[ $# -ge 1 ] || usage
ref=$1; shift
# a ref travels inside the remote script: plain ref characters only, never an option or a shell word
[[ $ref =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ ]] && [[ $ref != *..* ]] || { echo "serialhub-gate: not a plain ref: $ref" >&2; exit 22; }
if [ $# -gt 0 ]; then [ "$1" = -- ] || usage; shift; fi
cmd=${*:-bash scripts/gate.sh origin/master}
host=${TC_GATE_HOST:-serialhub}
repo=${TC_GATE_REPO:-https://github.com/jphein/teamclaude.git}
dir=${TC_GATE_DIR:-srv/wt/teamclaude-gate}
major=${TC_GATE_NODE:-22}
[[ $major =~ ^[0-9]{2}$ ]] || { echo "serialhub-gate: TC_GATE_NODE is a node major, e.g. 22" >&2; exit 22; }
read -r -a ssh_cmd <<<"${TC_GATE_SSH:-ssh -o BatchMode=yes}"
q() { printf '%q' "$1"; }

# Everything the host runs is this one script; the caller's values reach it %q-quoted, the command base64'd.
remote="set -eu
REF=$(q "$ref") REPO=$(q "$repo") DIR=$(q "$dir") MAJOR=$(q "$major") CMD64=$(printf '%s' "$cmd" | base64 | tr -d '\n')
case \$DIR in /*) ;; *) DIR=\$HOME/\$DIR ;; esac
nb=\$( { \$HOME/.local/bin/mise where node@\$MAJOR || mise where node@\$MAJOR; } 2>/dev/null | head -n1 )
[ -n \"\$nb\" ] && [ -x \"\$nb/bin/node\" ] && PATH=\$nb/bin:\$PATH
have=\$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0)
[ \"\$have\" -ge 20 ] || { echo \"serialhub-gate: node \$have on \$(hostname); 20 or later is needed\" >&2; exit 69; }
[ -d \"\$DIR/.git\" ] || git clone -q \"\$REPO\" \"\$DIR\"
cd \"\$DIR\"
git remote set-url origin \"\$REPO\"
git fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*'
sha=\$(git rev-parse -q --verify \"origin/\$REF^{commit}\" || git rev-parse -q --verify \"\$REF^{commit}\") \
  || { echo \"serialhub-gate: \$REF is not a commit or branch in \$REPO\" >&2; exit 22; }
git -c advice.detachedHead=false checkout -q --force \"\$sha\"
git clean -qfdx -e node_modules
echo \"gate on \$(hostname) at \$sha · node \$(node --version) · load \$(cut -d' ' -f1-3 /proc/loadavg)\"
if [ -e package-lock.json ]; then npm ci --no-audit --no-fund --ignore-scripts >/dev/null
else npm install --no-audit --no-fund --ignore-scripts >/dev/null; fi
set +e
cmd=\$(printf '%s' \"\$CMD64\" | base64 -d)
if command -v ionice >/dev/null; then ionice -c3 nice -n 10 sh -c \"\$cmd\"; else nice -n 10 sh -c \"\$cmd\"; fi"
exec "${ssh_cmd[@]}" "$host" "$remote"
