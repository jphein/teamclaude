#!/usr/bin/env bash
# CHECK forge-models: the Forge lists every model the fleet can reach, and every listed model answers
# (docs/CHECKS.md). Nightly 04:50. The work is in forge-models.mjs; this prints its one line.
#   fail: a reachable model is unlisted, a listed one did not answer, or a Foundry deployment drifted
#   warn: a source could not be read (named), or a desktop host is asleep
# Inputs (tests): CHECK_FM_INPUTS, CHECK_FM_OUT, CHECK_FM_NOW_MS, CHECK_FM_CONFIG (passed to node).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME=forge-models
NEXT="next run tomorrow 04:50 · owner teamclaude lane (gateway: palace-nemotron, page: plan lane)"
out=$(node "$(dirname "$0")/forge-models.mjs" 2>/dev/null) || out=""
case $out in
  ok$'\t'*|warn$'\t'*|fail$'\t'*) ;;
  *) check_emit "$NAME" fail "the check produced no verdict at $(check_now)" "$NEXT" ;;
esac
[ "$(printf '%s' "$out" | grep -c '')" = 1 ] || check_emit "$NAME" fail "the check produced more than one line at $(check_now)" "$NEXT"
check_emit "$NAME" "${out%%$'\t'*}" "${out#*$'\t'}, at $(check_now)" "$NEXT"
