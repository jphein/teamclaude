#!/usr/bin/env bash
# CHECK pool-quota: the teamclaude pool's 5-hour and weekly headroom, every 15 minutes (docs/CHECKS.md).
#   warn: five-hour remaining < 0.15, weekly-shared remaining < 0.30, or a seat bucket whose reset
#         time is more than 15 minutes past while it still shows usage (the numbers stopped updating)
#   fail: the quota endpoint does not answer, or answers without the aggregate numbers
# Seats at or above 90 % used (5-hour or weekly) are named in the line; alone they do not warn.
# Inputs (tests): CHECK_QUOTA_FILE (read instead of the endpoint), CHECK_QUOTA_URL, CHECK_NOW_MS.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME=pool-quota
NEXT="next run in 15 min · owner teamclaude lane"
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
  def used: [.buckets.fiveHour.utilization, .buckets.weeklyShared.utilization] | map(select(type == "number")) | (max // 0);
  if length != 1 or (.[0] | type) != "object" then "BAD" else .[0] end
  | if . == "BAD" then "BAD" else
  .aggregate as $a
  | if ($a.fiveHour.remaining | type) != "number" or ($a.weeklyShared.remaining | type) != "number" then "BAD"
    else [ $a.fiveHour.remaining, $a.weeklyShared.remaining,
           ([.accounts[]? | select(.disabled != true and used >= 0.9) | who] | join(" ")),
           ([.accounts[]? | select(.disabled != true) | . as $s
              | [.buckets[]? | select(type == "object" and (.resetAt | type) == "number"
                                      and .resetAt < ($now - 900000) and (.utilization // 0) > 0)]
              | select(length > 0) | $s | who] | unique | join(" ")),
           ([.accounts[]? | select(.disabled != true and .status != "active") | "\(who)=\(.status | tostring | gsub("[^A-Za-z0-9._-]"; "?"))"] | join(" "))
         ] | map(tostring) | join("\u001f") end end' <<<"$body" 2>/dev/null) || r=BAD
# exactly one record of five fields, or nothing here can be trusted
[ "$(printf '%s' "$r" | grep -c '')" = 1 ] && [ "$(printf '%s' "$r" | tr -cd '\037' | wc -c)" = 4 ] || r=BAD
[ "$r" = BAD ] || [ -z "$r" ] && check_emit "$NAME" fail "quota endpoint answered without aggregate numbers at $(check_now)" "$NEXT"
# \x1f, not a tab: read collapses runs of a whitespace IFS, so an empty field would shift the rest
IFS=$'\x1f' read -r five week hot stale inactive <<<"$r"
pct() { awk -v x="$1" 'BEGIN { printf "%d%%", x * 100 + 0.5 }'; }
status=ok; why=()
awk -v x="$five" 'BEGIN { exit !(x < 0.15) }' && { status=warn; why+=("5h under 15%"); }
awk -v x="$week" 'BEGIN { exit !(x < 0.30) }' && { status=warn; why+=("week under 30%"); }
[ -n "$stale" ] && { status=warn; why+=("stale buckets: $stale"); }
fact="5h $(pct "$five") left, week $(pct "$week") left"
[ ${#why[@]} -gt 0 ] && fact+=" ($(IFS=';'; echo "${why[*]}" | sed 's/;/; /g'))"
fact+=", seats ≥90% used: ${hot:-none}"
[ -n "$inactive" ] && fact+=", not active: $inactive"
fact+=", at $(check_now)"
check_emit "$NAME" "$status" "$fact" "$NEXT"
