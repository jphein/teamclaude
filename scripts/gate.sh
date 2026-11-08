#!/usr/bin/env bash
# The pre-merge gate: every check the CI node-24 job runs, locally and in the
# same order (tests, lint, typecheck, the strict-mode ratchet), so a PR is not
# found red only after it is pushed. A green `npm test` alone missed the
# ratchet on PR #56 (2026-11-04).
#
# usage: scripts/gate.sh [base]   base defaults to origin/master (fetched first)
#
# Proxy variables are cleared: the tests start local servers, and a forward
# proxy in the environment (HTTPS_PROXY, NO_PROXY) changes what they reach.
# Exit 0 only when every step passed; otherwise the first failing step's name
# and status. The last line is a one-line summary to quote in a PR comment.
set -u
cd "$(dirname "$0")/.." || exit 2
base=${1:-origin/master}
unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy NO_PROXY no_proxy
# tsc and eslint call module.enableCompileCache(), which writes to os.tmpdir()
# when this is unset: 3.6 MB per gate run into familiar's 512 MB RAM-backed
# /tmp (2026-11-07). Keep it on disk unless the caller already chose a place.
export NODE_COMPILE_CACHE=${NODE_COMPILE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/node-compile-cache}

if [ "$base" = origin/master ]; then
  git fetch -q origin master || { echo "gate: cannot fetch origin/master" >&2; exit 2; }
fi
git rev-parse -q --verify "$base^{commit}" >/dev/null || { echo "gate: unknown base $base" >&2; exit 2; }

head=$(git rev-parse --short HEAD)
summary=()
step() {
  local name=$1; shift
  printf '── gate: %s\n' "$name"
  "$@"
  local status=$?
  if [ $status -ne 0 ]; then
    echo "gate: FAILED at $name (exit $status) on $head" >&2
    exit 1
  fi
  summary+=("$name ok")
}

log=$(mktemp)
trap 'rm -f "$log"' EXIT
tests() {
  npm test >"$log" 2>&1
  local status=$?
  grep -E '^# (pass|fail|skipped) ' "$log"
  [ $status -ne 0 ] && grep -E '^not ok' "$log" | head -20
  return $status
}
step tests tests
step lint npm run -s lint
step typecheck npm run -s typecheck
step "strict ratchet" node scripts/typecheck-strict.mjs --base "$(git rev-parse "$base")"

counts=$(grep -E '^# (pass|fail|skipped) ' "$log" | awk '{printf "%s %s, ", $3, $2}' | sed 's/, $//')
echo "gate: PASS on $head vs $(git rev-parse --short "$base") — ${summary[*]} (tests: $counts)"
