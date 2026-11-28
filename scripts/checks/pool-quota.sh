#!/usr/bin/env bash
# CHECK pool-quota: the teamclaude pool's 5-hour and weekly headroom, every 15 minutes (docs/CHECKS.md).
#   warn: five-hour remaining < 0.15, weekly-shared remaining <= 0.15, or a seat bucket whose reset
#         time is more than 15 minutes past while it still shows usage (the numbers stopped updating),
#         or a seat's keep-warm touch more than 60 s after its reset, or missing 60 s after it (any note)
#   The line shows each seat's last reset and its touch (stagger.seats[].lastResetAt/touchedAt).
#   fail: weekly-shared remaining <= 0.05, the quota endpoint does not answer, or it answers without
#         the aggregate numbers
# The weekly limits follow the 7-day switch threshold: at 1.0 (JP, 2026-11-15) seats are used to the
# end of their week, so a weekly pool under 30 % is normal, not a warning. The line names the
# weekly reset (aggregate.weeklyShared.nextResetAt) whenever the proxy reports it.
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
           ([.accounts[]? | select(.disabled != true and .status != "active") | "\(who)=\(.status | tostring | gsub("[^A-Za-z0-9._-]"; "?"))"] | join(" ")),
           (if ($a.weeklyShared.nextResetAt | type) == "number" and $a.weeklyShared.nextResetAt > 0
              then ($a.weeklyShared.nextResetAt / 1000 | floor) else "" end)
         ] | map(tostring) | join("\u001f") end end' <<<"$body" 2>/dev/null) || r=BAD
# exactly one record of six fields, or nothing here can be trusted
[ "$(printf '%s' "$r" | grep -c '')" = 1 ] && [ "$(printf '%s' "$r" | tr -cd '\037' | wc -c)" = 5 ] || r=BAD
[ "$r" = BAD ] || [ -z "$r" ] && check_emit "$NAME" fail "quota endpoint answered without aggregate numbers at $(check_now)" "$NEXT"
# \x1f, not a tab: read collapses runs of a whitespace IFS, so an empty field would shift the rest
IFS=$'\x1f' read -r five week hot stale inactive reset_s <<<"$r"
pct() { awk -v x="$1" 'BEGIN { printf "%d%%", x * 100 + 0.5 }'; }
status=ok; why=()
awk -v x="$five" 'BEGIN { exit !(x < 0.15) }' && { status=warn; why+=("5h under 15%"); }
if awk -v x="$week" 'BEGIN { exit !(x <= 0.05) }'; then status=fail; why+=("week at or under 5%")
elif awk -v x="$week" 'BEGIN { exit !(x <= 0.15) }'; then status=warn; why+=("week at or under 15%"); fi
[ -n "$stale" ] && { [ "$status" = fail ] || status=warn; why+=("stale buckets: $stale"); }
# The touches (row f8f91adf, JP 2026-11-27 13:0x; the lead's ruling on PR 108 round 1): every seat, from the
# stagger's follower, as "reset HH:MM, touch HH:MM, lag Ns", or "reset unknown, slot HH:MM starts it", or "reset
# unknown, no touch planned (<why>)". A touch more than 60 s after its reset warns, and so does a reset more than
# 60 s past with no touch, whatever its note says; the note (a failure, a skip) is appended, never an excuse.
# A window a request started right after the reset is a touch the proxy records as one (touchedBy "request").
tl=$(jq -r '
  def who: (.name // "?") | tostring | split("@")[0] | gsub("[^A-Za-z0-9._-]"; "?");
  def secs: if type == "string" then (try (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) catch "") else "" end;
  def clean: tostring | gsub("[^A-Za-z0-9 ._:()%+-]"; "?") | .[0:60];
  if (.stagger | type) != "object" then "NONE"
  elif .stagger.enabled != true then "OFF"
  else (.stagger.seats // [])[] | select(type == "object")
    # the reset reported: a pending one (no successful touch yet: retrying, given up, skipped) when it is newer
    # than the last reset a touch succeeded for, and then with no touch
    | (.lastResetAt | secs) as $l | (.pendingResetAt | secs) as $p
    | (if ($p | type) == "number" and (($l | type) != "number" or $p > $l) then [$p, "", ""]
       else [$l, (.touchedAt | secs), (if (.touchLagSeconds | type) == "number" then .touchLagSeconds else "" end)] end) as $rt
    | [who, $rt[0], $rt[1], $rt[2],
       ((.followNote // "") | clean), (.nextFollowAt | secs),
       (if (.slot | type) == "string" and (.slot | test("^[0-2][0-9]:[0-5][0-9]$")) then .slot else "" end),
       ((.last // "") | tostring | (try capture("^no slot today \\((?<w>[^)]*)\\)").w catch "") | clean)]
    | map(tostring) | join("\u001f") end' <<<"$body" 2>/dev/null) || tl=NONE
touches=
case $tl in
  NONE) ;;
  OFF) touches="stagger off" ;;
  *)
    parts=(); late=(); missing=()
    # HH:MM for a time today, "Sat 14:00" for any other day (a weekly reset days away must not read as today)
    today=$(date -d "@$(( now_ms / 1000 ))" '+%F')
    hm() { if [ "$(date -d "@$1" '+%F')" = "$today" ]; then date -d "@$1" '+%H:%M'; else date -d "@$1" '+%a %H:%M'; fi; }
    okt() { [[ $1 =~ ^[0-9]{9,11}$ ]]; }
    while IFS=$'\x1f' read -r w r tch lag note nxt slot nwhy; do
      [ -n "$w" ] || continue
      if okt "$r"; then
        if [[ $lag =~ ^-?[0-9]+$ ]] && okt "$tch"; then
          parts+=("$w reset $(hm "$r"), touch $(hm "$tch"), lag ${lag}s${note:+ ($note)}")
          [ "$lag" -gt 60 ] && late+=("$w +${lag}s")
        elif [ $(( now_ms / 1000 - r )) -gt 60 ]; then parts+=("$w reset $(hm "$r"), no touch${note:+ ($note)}"); missing+=("$w")
        else parts+=("$w reset $(hm "$r"), touch due${note:+ ($note)}"); fi
      elif okt "$nxt"; then parts+=("$w reset $(hm "$nxt"), touch due")
      elif [ -n "$slot" ]; then parts+=("$w reset unknown, slot $slot starts it")
      else parts+=("$w reset unknown, no touch planned${nwhy:+ ($nwhy)}"); fi
    done <<<"$tl"
    [ ${#late[@]} -gt 0 ] && { [ "$status" = fail ] || status=warn; why+=("touch late: ${late[*]}"); }
    [ ${#missing[@]} -gt 0 ] && { [ "$status" = fail ] || status=warn; why+=("touch missing: ${missing[*]}"); }
    touches=$( [ ${#parts[@]} -gt 0 ] && { IFS=$'\x1f'; echo "${parts[*]}"; } | sed $'s/\x1f/; /g')
    touches=${touches:-no seat} ;;
esac
fact="5h $(pct "$five") left, week $(pct "$week") left"
[ ${#why[@]} -gt 0 ] && fact+=" ($(IFS=';'; echo "${why[*]}" | sed 's/;/; /g'))"
[[ $reset_s =~ ^[0-9]{9,11}$ ]] && fact+=", week resets $(date -d "@$reset_s" '+%a %m-%d %H:%M')"
fact+=", seats ≥90% used: ${hot:-none}"
[ -n "$inactive" ] && fact+=", not active: $inactive"
[ -n "$touches" ] && fact+=", touches: $touches"
fact+=", at $(check_now)"
check_emit "$NAME" "$status" "$fact" "$NEXT"
