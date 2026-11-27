#!/usr/bin/env bash
# Run the gate on a lane host, never on the machine the fleet's agents live on: the full suite at a load of
# 12–15 on familiar timed out files and flaked timing tests (rows 52cff50c, f9776f22), so every full `npm
# test`, `scripts/gate.sh` and perturbation run goes to serialhub (row 8aa26057, the lead 2026-11-24 17:1x).
#
# usage: scripts/serialhub-gate.sh <commit|branch> [-- <program> [<arg>…]]
#   A branch is resolved HERE to the commit the gate repo (default: the fork on GitHub) has for it, and that
#   commit, printed to stderr, is what runs, whatever the branch does meanwhile; a commit must be pushed. On the
#   host, under a lock on the clone (a second gate meanwhile is refused), a dedicated clone (not a synced tree)
#   is fetched, checked out detached at that commit and cleaned of everything untracked but node_modules;
#   dependencies are installed with `npm ci --ignore-scripts` from the commit's package-lock.json, npm's cache
#   and logs in a per-run dir beside the clone, removed after; then <program> runs with its arguments exactly
#   as given (no shell reads them again) under ionice/nice. It defaults to `bash scripts/gate.sh origin/master`.
#   Its stdin is this script's stdin, so `-- sh -s < perturb.sh` runs a local perturbation script in the clone.
# Exit: <program>'s · 22 a bad or unknown ref, or usage · 65 no package-lock.json at the commit · 69 the gate
#   repo unreachable, or no node 20+ on the host · 75 another gate holds the clone · other: a failed step, named.
# Env: TC_GATE_HOST (serialhub), TC_GATE_SSH (ssh -o BatchMode=yes), TC_GATE_REPO (the fork's https URL),
#   TC_GATE_DIR (srv/wt/teamclaude-gate, under the host's $HOME), TC_GATE_NODE (22: the node major taken
#   from mise on the host when installed there; otherwise the host's node, which must be 20 or later).
set -u
usage() { echo "usage: scripts/serialhub-gate.sh <commit|branch> [-- <program> [<arg>…]]" >&2; exit 22; }
[ $# -ge 1 ] || usage
ref=$1; shift
# a ref travels to git and the host: plain ref characters only, never an option or a shell word
[[ $ref =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ ]] && [[ $ref != *..* ]] || { echo "serialhub-gate: not a plain ref: $ref" >&2; exit 22; }
if [ $# -gt 0 ]; then { [ "$1" = -- ] && [ $# -ge 2 ]; } || usage; shift
else set -- bash scripts/gate.sh origin/master; fi
host=${TC_GATE_HOST:-serialhub}
repo=${TC_GATE_REPO:-https://github.com/jphein/teamclaude.git}
dir=${TC_GATE_DIR:-srv/wt/teamclaude-gate}
major=${TC_GATE_NODE:-22}
[[ $major =~ ^[0-9]{2}$ ]] || { echo "serialhub-gate: TC_GATE_NODE is a node major, e.g. 22" >&2; exit 22; }
read -r -a ssh_cmd <<<"${TC_GATE_SSH:-ssh -o BatchMode=yes}"

# Resolve once, here: the commit printed is the commit gated, even if the branch moves before the host fetches.
if [[ $ref =~ ^[0-9a-f]{40}$ ]]; then sha=$ref
else
  heads=$(git ls-remote --heads "$repo" "refs/heads/$ref") || { echo "serialhub-gate: cannot list the branches of $repo" >&2; exit 69; }
  sha=$(awk -v r="refs/heads/$ref" '$2 == r { print $1; exit }' <<<"$heads")
  if [ -z "$sha" ] && [[ $ref =~ ^[0-9a-f]{7,39}$ ]]; then sha=$(git rev-parse -q --verify "$ref^{commit}" 2>/dev/null) || sha=; fi
  [ -n "$sha" ] || { echo "serialhub-gate: $ref is not a branch of $repo or a commit known here" >&2; exit 22; }
fi
echo "serialhub-gate: $ref is $sha" >&2

q() { printf '%q' "$1"; }
# Everything the host runs is this one bash script. Values and the argv reach it %q-quoted, so bash reads each
# back as the one word it was; the script itself reaches the login shell in POSIX single quotes.
remote="set -eu
SHA=$(q "$sha") REPO=$(q "$repo") DIR=$(q "$dir") MAJOR=$(q "$major")
set -- $(printf '%q ' "$@")
case \$DIR in /*) ;; *) DIR=\$HOME/\$DIR ;; esac
mkdir -p \"\$(dirname \"\$DIR\")\"
exec 9>>\"\$DIR.lock\"
flock -n 9 || { echo \"serialhub-gate: another gate holds \$DIR on \$(hostname); run again when it ends\" >&2; exit 75; }
nb=\$( { \$HOME/.local/bin/mise where node@\$MAJOR || mise where node@\$MAJOR; } 2>/dev/null | head -n1 )
[ -n \"\$nb\" ] && [ -x \"\$nb/bin/node\" ] && PATH=\$nb/bin:\$PATH
have=\$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0)
[ \"\$have\" -ge 20 ] || { echo \"serialhub-gate: node \$have on \$(hostname); 20 or later is needed\" >&2; exit 69; }
[ -d \"\$DIR/.git\" ] || git clone -q \"\$REPO\" \"\$DIR\"
cd \"\$DIR\"
git remote set-url origin \"\$REPO\"
git fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*'
git cat-file -e \"\$SHA^{commit}\" 2>/dev/null || git fetch -q origin \"\$SHA\" 2>/dev/null || true
sha=\$(git rev-parse -q --verify \"\$SHA^{commit}\") || { echo \"serialhub-gate: \$SHA is not a commit in \$REPO\" >&2; exit 22; }
git -c advice.detachedHead=false checkout -q --force \"\$sha\"
git clean -qfdx -e node_modules
echo \"gate on \$(hostname) at \$sha · node \$(node --version) · load \$(cut -d' ' -f1-3 /proc/loadavg)\"
[ -e package-lock.json ] || { echo \"serialhub-gate: no package-lock.json at \$sha: the gate installs only with npm ci\" >&2; exit 65; }
npmdir=\$(mktemp -d \"\$DIR.npm.XXXXXX\")
trap 'rm -rf \"\$npmdir\"' EXIT
export npm_config_cache=\$npmdir/cache npm_config_logs_dir=\$npmdir/logs npm_config_update_notifier=false
npm ci --no-audit --no-fund --ignore-scripts >/dev/null
set +e
if command -v ionice >/dev/null; then ionice -c3 nice -n 10 \"\$@\" 9>&-; else nice -n 10 \"\$@\" 9>&-; fi"
sq() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
exec "${ssh_cmd[@]}" "$host" "exec bash -c $(sq "$remote")"
