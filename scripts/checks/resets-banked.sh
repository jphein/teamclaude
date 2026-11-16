#!/usr/bin/env bash
# CHECK resets-banked: the pool's banked Claude usage-limit resets (docs/CHECKS.md). Daily.
#   The line: banked resets split weekly-clearing / 5h-only, each with its soonest expiry, and how many
#   were spent in the last 7 days (any path: pool-dry, rule, operator).
#   warn: a seat holds a reset that expires within 48 h unspent (it would be lost)
#   warn also: a seat's reading is older than 2 h (the probe runs every 30 min; on 2026-11-16 five seats
#         sat 3-8 h stale behind 401s): it is named and left out of the counts
#   fail: the quota endpoint does not answer or holds no valid seats list; or no seat has a FRESH
#         reading (the probe is down: a stale count must not read as ok)
# Inputs (tests): CHECK_QUOTA_FILE (read instead of the endpoint), CHECK_QUOTA_URL, CHECK_NOW_MS.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME=resets-banked
NEXT="next run tomorrow 07:45 · owner teamclaude lane"
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
  def who: (.name // "?") | tostring | split("@")[0] | gsub("[^A-Za-z0-9._-]"; "?");
  # an expiry is null (none) or a parseable ISO time; anything else is "BAD", never a silent null
  def ms: if . == null then null elif type == "string" then (try (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 * 1000) catch "BAD") else "BAD" end;
  def cnt: if type == "number" and . >= 0 and . == floor then . else null end;
  if length != 1 or (.[0] | type) != "object" or (.[0].seats | type) != "array"
     or ([.[0].seats[] | type == "object"] | all | not) then "BAD" else
  [.[0].seats[] | . as $s | .resets as $r
    | if $r == null then {who: ($s | who), read: false, spent: ($s.resetsSpent7d | cnt // 0)}
      # weeklyBanked = every weekly-clearing reset, usable now or not (a proxy without it cannot be split)
      elif ($r | type) == "object" and ($r.available | cnt) != null and ($r.weeklyBanked | cnt) != null
           and ($r.weeklyBanked <= $r.available) then
        # fresh = read within 2 h (the probe runs every 30 min); an older reading is stale and not counted
        ($r.seenAt | ms) as $seen
        | {who: ($s | who), read: ($seen != null and $seen != "BAD" and $seen <= $now and $now - $seen <= 7200000),
           stale: ($seen == null or ($seen != "BAD" and $now - $seen > 7200000)), seenBad: ($seen == "BAD"),
           avail: $r.available, weekly: $r.weeklyBanked,
           wexp: ($r.weeklyBankedExpiresAt | ms), fexp: ($r.otherExpiresAt | ms), exp: ($r.expiresAt | ms),
           spent: ($s.resetsSpent7d | cnt // 0)}
      else {bad: true} end] as $rows
  | if ([$rows[] | .bad == true or .seenBad == true or .wexp == "BAD" or .fexp == "BAD" or .exp == "BAD"] | any) then "BAD" else
  [$rows[] | select(.read)] as $read
  | ([$read[].weekly] | add // 0) as $w
  | (([$read[].avail] | add // 0) - $w) as $five
  | [ ($read | length | tostring), ($w | tostring), ($five | tostring),
      ([$read[] | select(.weekly > 0 and .wexp != null) | .wexp] | min // "" | tostring),
      ([$read[] | select(.avail > .weekly and .fexp != null) | .fexp] | min // "" | tostring),
      ([$rows[].spent] | add // 0 | tostring),
      ([$read[] | select(.avail > 0 and .exp != null and .exp > $now and .exp - $now <= 172800000) | .who] | join(" ")),
      ([$rows[] | select((.read | not) and (.stale | not)) | .who] | join(" ")),
      ([$rows[] | select(.stale == true) | .who] | join(" "))
    ] | join("\u001f") end end' <<<"$body" 2>/dev/null) || r=BAD
[ "$(printf '%s' "$r" | grep -c '')" = 1 ] && [ "$(printf '%s' "$r" | tr -cd '\037' | wc -c)" = 8 ] || r=BAD
[ "$r" = BAD ] || [ -z "$r" ] && check_emit "$NAME" fail "quota endpoint answered without a valid seats list at $(check_now)" "$NEXT"
IFS=$'\x1f' read -r nread weekly five wexp fexp spent expiring unread stale <<<"$r"
[ "$nread" = 0 ] && check_emit "$NAME" fail "no seat has a fresh reset reading (probe down?)${stale:+, stale over 2 h: $stale}${unread:+, unread: $unread}, at $(check_now)" "$NEXT"
day() { [[ $1 =~ ^[0-9]{12,14}$ ]] && date -d "@$(( $1 / 1000 ))" '+%b %-d' || echo '?'; }
fact="banked: weekly-clearing $weekly"
[ "$weekly" != 0 ] && fact+=" (soonest expiry $(day "$wexp"))"
fact+=", 5h-only $five"
[ "$five" != 0 ] && fact+=" (soonest expiry $(day "$fexp"))"
fact+="; spent in 7 days: $spent"
status=ok
[ -n "$expiring" ] && { status=warn; fact+="; expiring within 48 h unspent: $expiring"; }
[ -n "$stale" ] && { status=warn; fact+="; stale over 2 h (not counted): $stale"; }
[ -n "$unread" ] && fact+=", no reading: $unread"
fact+=", at $(check_now)"
check_emit "$NAME" "$status" "$fact" "$NEXT"
