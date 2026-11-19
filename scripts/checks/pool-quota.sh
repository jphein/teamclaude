#!/usr/bin/env bash
# CHECK pool-quota: who in the teamclaude pool can serve right now, and when each barred seat comes back, every 15
# minutes (docs/CHECKS.md). The line is the per-seat picture lanes read before calling a notice a wall (Sen 2026-11-19:
# the lead's seat drew six per-seat notices in 18 h while the line read "5h 45-99% left", the 5h capacity of seats whose
# week was spent).
#   A seat (not disabled, status active) is
#     serving     when its week is under 98 % used and its 5 hours under 97 % (the proxy's servable rule and 5h switch),
#     5h-full     when its week has room but its 5 hours do not: back at its 5h reset,
#     week-spent  when its week is 98 % or more used: back at its weekly reset.
#   The count of serving seats is the proxy's own live_seats when it reports one, else the count above.
#   fail: no seat serves (a real wall: the line names when the first seat comes back), the endpoint does not answer,
#         or it answers without the aggregate numbers
#   warn: one seat serves, the servable 5h headroom is under 15 % (the raw figure when the proxy reports no servable
#         one), the weekly-shared remaining is at or under 15 %, or a seat bucket whose reset time is more than
#         15 minutes past still shows usage (the numbers stopped updating)
# Inputs (tests): CHECK_QUOTA_FILE (read instead of the endpoint), CHECK_QUOTA_URL, CHECK_NOW_MS.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME=pool-quota
NEXT="a seat notice is not a wall while a seat serves · next run in 15 min · owner teamclaude lane"
url=${CHECK_QUOTA_URL:-http://127.0.0.1:3456/teamclaude/quota}
if [ -n "${CHECK_QUOTA_FILE:-}" ]; then
  body=$(cat "$CHECK_QUOTA_FILE" 2>/dev/null) || check_emit "$NAME" fail "cannot read $CHECK_QUOTA_FILE at $(check_now)" "$NEXT"
else
  body=$(env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY \
    curl -q -s -f --noproxy '*' --max-time 15 "$url" 2>/dev/null) \
    || check_emit "$NAME" fail "quota endpoint $url did not answer at $(check_now)" "$NEXT"
fi
now_ms=${CHECK_NOW_MS:-$(( $(date +%s) * 1000 ))}
# One record, \x1f-separated: five, servable, week, live, total, serving, fivefull, spent, stale, inactive, first_back_s.
# serving: "name 5h% wk%" items joined by ";"; fivefull and spent: "names Day HH:MM" groups, soonest first, joined by
# ", " (seats whose resets fall in the same minute share one group).
r=$(jq -r -s --argjson now "$now_ms" '
  # the local part only, reduced to [A-Za-z0-9._-]: a name never carries an escape into the line
  def who: (.name // "?") | tostring | split("@")[0] | gsub("[^A-Za-z0-9._-]"; "?");
  def u($b): (.buckets[$b].utilization // null) | if type == "number" then . else null end;
  def at($b): (.buckets[$b].resetAt // null) | if type == "number" and . > 0 and . < 1e14 then (. / 1000 | floor) else null end;
  def p: if . == null then "?" else (. * 100 + 0.5 | floor | tostring) + "%" end;
  def hm: if . == null then "?" else strflocaltime("%a %H:%M") end;
  # [{t, who}] -> "a b Thu 20:59, c Fri 12:00": by time, a group per minute, unknown times last
  def backs: map({k: (if .t == null then 1e12 else (.t / 60 | floor) end), t, who}) | sort_by(.k, .who) | group_by(.k)
             | map("\(map(.who) | join(" ")) \(.[0].t | hm)") | join(", ");
  if length != 1 or (.[0] | type) != "object" then "BAD" else .[0] end
  | if . == "BAD" then "BAD" else
  .aggregate as $a
  | if ($a.fiveHour.remaining | type) != "number" or ($a.weeklyShared.remaining | type) != "number" then "BAD"
    else
      [.accounts[]? | select(.disabled != true)] as $seats
      | [$seats[] | select(.status == "active")] as $act
      | [$act[] | select((u("weeklyShared") // 1) < 0.98 and (u("fiveHour") // 0) < 0.97)] as $srv
      | [$act[] | select((u("weeklyShared") // 1) < 0.98 and (u("fiveHour") // 0) >= 0.97)] as $f5
      | [$act[] | select((u("weeklyShared") // 1) >= 0.98)] as $wk
      | ([$f5[] | at("fiveHour")] + [$wk[] | at("weeklyShared")] | map(select(. != null)) | min) as $first
      | [ $a.fiveHour.remaining,
          ($a.fiveHour.servableRemaining | if type == "number" then . else "" end),
          $a.weeklyShared.remaining,
          (.live_seats | if type == "number" then . else ($srv | length) end),
          ($seats | length),
          ([$srv[] | "\(who) \(u("fiveHour") | p) \(u("weeklyShared") | p)"] | join(";")),
          ([$f5[] | {t: at("fiveHour"), who: who}] | backs),
          ([$wk[] | {t: at("weeklyShared"), who: who}] | backs),
          ([$seats[] | . as $s
              | [.buckets[]? | select(type == "object" and (.resetAt | type) == "number"
                                      and .resetAt < ($now - 900000) and (.utilization // 0) > 0)]
              | select(length > 0) | $s | who] | unique | join(" ")),
          ([$seats[] | select(.status != "active") | "\(who)=\(.status | tostring | gsub("[^A-Za-z0-9._-]"; "?"))"] | join(" ")),
          (if $first == null then "" else ($first | hm) end)
        ] | map(tostring) | join("\u001f") end end' <<<"$body" 2>/dev/null) || r=BAD
# exactly one record of eleven fields, or nothing here can be trusted
[ "$(printf '%s' "$r" | grep -c '')" = 1 ] && [ "$(printf '%s' "$r" | tr -cd '\037' | wc -c)" = 10 ] || r=BAD
[ "$r" = BAD ] || [ -z "$r" ] && check_emit "$NAME" fail "quota endpoint answered without aggregate numbers at $(check_now)" "$NEXT"
# \x1f, not a tab: read collapses runs of a whitespace IFS, so an empty field would shift the rest
IFS=$'\x1f' read -r five servable week live total serving fivefull spent stale inactive first_s <<<"$r"
pct() { awk -v x="$1" 'BEGIN { printf "%d%%", x * 100 + 0.5 }'; }
[[ $live =~ ^[0-9]+$ ]] || live=0
[[ $total =~ ^[0-9]+$ ]] || total=0
status=ok; why=()
if [ "$live" = 0 ]; then status=fail; why+=("no seat serves: a wall")
elif [ "$live" = 1 ]; then status=warn; why+=("one seat serves"); fi
room=${servable:-$five}
awk -v x="$room" 'BEGIN { exit !(x < 0.15) }' && { [ "$status" = fail ] || status=warn; why+=("5h servable under 15%"); }
awk -v x="$week" 'BEGIN { exit !(x <= 0.15) }' && { [ "$status" = fail ] || status=warn; why+=("week at or under 15%"); }
[ -n "$stale" ] && { [ "$status" = fail ] || status=warn; why+=("stale buckets: $stale"); }

if [ -n "$serving" ]; then
  srv=$(tr ';' '\n' <<<"$serving" | awk '{ printf "%s%s (5h %s, week %s used)", (NR > 1 ? ", " : ""), $1, $2, $3 }')
  fact="serving $live of $total seats: $srv"
else
  fact="serving $live of $total seats"
  [ -n "$first_s" ] && fact+=", first back $first_s"
fi
[ -n "$fivefull" ] && fact+="; 5h-full, back: $fivefull"
[ -n "$spent" ] && fact+="; week-spent, back: $spent"
if [ -n "$servable" ]; then fact+="; 5h servable $(pct "$servable") (raw $(pct "$five")), week $(pct "$week") left"
else fact+="; 5h $(pct "$five") left, week $(pct "$week") left"; fi
[ ${#why[@]} -gt 0 ] && fact+=" ($(IFS=';'; echo "${why[*]}" | sed 's/;/; /g'))"
[ -n "$inactive" ] && fact+=", not active: $inactive"
fact+=", at $(check_now)"
check_emit "$NAME" "$status" "$fact" "$NEXT"
