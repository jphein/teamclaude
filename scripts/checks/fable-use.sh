#!/usr/bin/env bash
# CHECK fable-use: each seat's Fable weekly bucket, used before it resets (docs/CHECKS.md). Daily.
#   warn: a seat's Fable week ends within 24 h with under 1 % of it used: that allowance expires unused
#         (JP's "use down all credits" rule; the proxy rations Fable to fable.allow keys, so it can sit
#         at 0 % all week without anyone seeing it)
#   fail: the quota endpoint does not answer, answers without the accounts list, or holds an account
#         entry that is not an object or a Fable bucket that is present but malformed (utilization
#         outside 0..1, or no numeric reset time): an unreadable bucket is never read as ok
# Seats' Fable weeks end at different times, so the check runs daily and judges each seat by its own
# reset, not one weekly run that would miss most of them. Seats without a Fable bucket are named, and
# do not warn alone.
# Inputs (tests): CHECK_QUOTA_FILE (read instead of the endpoint), CHECK_QUOTA_URL, CHECK_NOW_MS.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME=fable-use
NEXT="next run tomorrow 07:40 · owner teamclaude lane"
url=${CHECK_QUOTA_URL:-http://127.0.0.1:3456/teamclaude/quota}
if [ -n "${CHECK_QUOTA_FILE:-}" ]; then
  body=$(cat "$CHECK_QUOTA_FILE" 2>/dev/null) || check_emit "$NAME" fail "cannot read $CHECK_QUOTA_FILE at $(check_now)" "$NEXT"
else
  body=$(env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY \
    curl -q -s -f --noproxy '*' --max-time 15 "$url" 2>/dev/null) \
    || check_emit "$NAME" fail "quota endpoint $url did not answer at $(check_now)" "$NEXT"
fi
now_ms=${CHECK_NOW_MS:-$(( $(date +%s) * 1000 ))}
r=$(jq -r -s --argjson now "$now_ms" '
  # the local part only, reduced to [A-Za-z0-9._-]: a name never carries an escape into the line
  def who: (.name // "?") | tostring | split("@")[0] | gsub("[^A-Za-z0-9._-]"; "?");
  def pct: (. * 100 + 0.5 | floor | tostring) + "%";
  # a bucket is either absent (null or missing: named, never a warn) or valid (utilization in [0,1],
  # a positive numeric resetAt); anything else, or an account entry that is not an object, is BAD
  def valid: type == "object" and (.utilization | type) == "number" and .utilization >= 0 and .utilization <= 1
                 and (.resetAt | type) == "number" and .resetAt > 0;
  if length != 1 or (.[0] | type) != "object" or (.[0].accounts | type) != "array"
     or ([.[0].accounts[] | type == "object"] | all | not) then "BAD" else
  [.[0].accounts[] | select(.disabled != true)] as $seats
  | [$seats[] | . as $s | .buckets.weeklyFable as $b
      | if $b == null then {who: ($s | who), u: null, r: null}
        elif ($b | valid) then {who: ($s | who), u: $b.utilization, r: $b.resetAt}
        else {bad: true} end] as $rows
  | if ([$rows[] | .bad == true] | any) then "BAD" else
  [$rows[] | select(.u != null)] as $known
  | [ ($known | length | tostring),
      (if ($known | length) > 0 then ([$known[].u] | add / length | pct) else "" end),
      ([$known[] | "\(.who) \(.u | pct)"] | join(", ")),
      ([$known[] | select(.r > $now and .r - $now <= 86400000 and .u < 0.01) | .who] | join(" ")),
      ([$rows[] | select(.u == null) | .who] | join(" "))
    ] | join("\u001f") end end' <<<"$body" 2>/dev/null) || r=BAD
# exactly one record of five fields, or nothing here can be trusted
[ "$(printf '%s' "$r" | grep -c '')" = 1 ] && [ "$(printf '%s' "$r" | tr -cd '\037' | wc -c)" = 4 ] || r=BAD
[ "$r" = BAD ] || [ -z "$r" ] && check_emit "$NAME" fail "quota endpoint answered without a valid accounts list (or a malformed Fable bucket) at $(check_now)" "$NEXT"
IFS=$'\x1f' read -r count avg per ending missing <<<"$r"
status=ok
if [ "$count" = 0 ]; then fact="no seat reports a Fable bucket"
else
  fact="Fable week used: pool avg $avg ($per)"
  [ -n "$ending" ] && { status=warn; fact+="; ending unused within 24 h: $ending"; }
fi
[ -n "$missing" ] && fact+=", no Fable bucket: $missing"
fact+=", at $(check_now)"
check_emit "$NAME" "$status" "$fact" "$NEXT"
