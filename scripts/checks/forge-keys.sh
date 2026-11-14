#!/usr/bin/env bash
# CHECK forge-keys: the forge gateway's (LiteLLM on ubox0) virtual keys, daily (docs/CHECKS.md).
#   warn: in the last 30 days a key spent on a model outside its allowlist; a key older than 30 days
#         has not been used in 30 days (prune candidate); or a key the gateway does not know (not
#         active, not deleted, not the master) spent in the last 7 days. "Spent" and "used" mean
#         status = success: LiteLLM also logs refused calls (a key denied a model) as failure rows.
#   info: refused calls in 7 days by keys that are not active, and how many by deleted keys (someone
#         trying a revoked key shows here); this alone does not warn
#   fail: the gateway's database cannot be read
# Read-only: one SELECT batch through psql inside forge-db-1. Key hashes are LiteLLM's sha256 of
# the key, never a key; the line names aliases only.
# Inputs (tests): CHECK_FORGE_PSQL (a command that reads SQL on stdin and prints psql -At output).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME=forge-keys
NEXT="next run tomorrow 07:20 · owner teamclaude lane (gateway: palace-nemotron)"
psql_cmd() {
  if [ -n "${CHECK_FORGE_PSQL:-}" ]; then $CHECK_FORGE_PSQL; return; fi
  timeout 90 ssh -o BatchMode=yes -o ConnectTimeout=8 ubox0 \
    "docker exec -i forge-db-1 sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"\${POSTGRES_DB:-\$POSTGRES_USER}\" -At -F \"|\"'"
}
out=$(psql_cmd <<'SQL' 2>/dev/null
SELECT 'KEYS', count(*) FROM "LiteLLM_VerificationToken";
SELECT 'OUT', coalesce(t.key_alias, '(no alias)'), s.model_group, count(*)
  FROM "LiteLLM_SpendLogs" s JOIN "LiteLLM_VerificationToken" t ON t.token = s.api_key
 WHERE s."startTime" > now() - interval '30 days' AND coalesce(s.model_group, '') <> '' AND s.status = 'success'
   AND NOT ('all-proxy-models' = ANY(coalesce(t.models, '{}')))
   AND NOT (s.model_group = ANY(coalesce(t.models, '{}')))
 GROUP BY 2, 3;
SELECT 'IDLE', coalesce(t.key_alias, '(no alias)')
  FROM "LiteLLM_VerificationToken" t
 WHERE t.created_at < now() - interval '30 days'
   AND NOT EXISTS (SELECT 1 FROM "LiteLLM_SpendLogs" s WHERE s.api_key = t.token AND s.status = 'success' AND s."startTime" > now() - interval '30 days');
SELECT 'UNKNOWN', count(*), count(DISTINCT s.api_key)
  FROM "LiteLLM_SpendLogs" s
 WHERE s."startTime" > now() - interval '7 days' AND s.status = 'success' AND coalesce(s.api_key, '') NOT IN ('', 'litellm_proxy_master_key')
   AND NOT EXISTS (SELECT 1 FROM "LiteLLM_VerificationToken" t WHERE t.token = s.api_key)
   AND NOT EXISTS (SELECT 1 FROM "LiteLLM_DeletedVerificationToken" d WHERE d.token = s.api_key);
SELECT 'REFUSED', count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "LiteLLM_VerificationToken" t WHERE t.token = s.api_key)),
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "LiteLLM_DeletedVerificationToken" d WHERE d.token = s.api_key))
  FROM "LiteLLM_SpendLogs" s
 WHERE s."startTime" > now() - interval '7 days' AND s.status <> 'success' AND coalesce(s.api_key, '') NOT IN ('', 'litellm_proxy_master_key');
SELECT 'END';
SQL
) || check_emit "$NAME" fail "cannot read the gateway database (forge-db-1 on ubox0) at $(check_now)" "$NEXT"
# a cut-off answer must not read as "nothing wrong": the batch has to reach its END marker
grep -qx 'END' <<<"$out" && grep -qE '^KEYS\|[0-9]+$' <<<"$out" \
  || check_emit "$NAME" fail "gateway database answered incompletely at $(check_now)" "$NEXT"
keys=$(sed -n 's/^KEYS|//p' <<<"$out")
outside=$(awk -F'|' '$1=="OUT" {printf "%s%s→%s ×%s", (n++ ? ", " : ""), $2, $3, $4}' <<<"$out")
idle=$(awk -F'|' '$1=="IDLE" {printf "%s%s", (n++ ? " " : ""), $2}' <<<"$out")
IFS='|' read -r _ unk_rows unk_keys <<<"$(grep '^UNKNOWN|' <<<"$out")"
IFS='|' read -r _ ref_all ref_del <<<"$(grep '^REFUSED|' <<<"$out")"
status=ok; why=()
[ -n "$outside" ] && { status=warn; why+=("spend outside allowlist: $outside"); }
[ -n "$idle" ] && { status=warn; why+=("unused 30 days (prune candidates): $idle"); }
[ "${unk_rows:-0}" -gt 0 ] 2>/dev/null && { status=warn; why+=("unknown keys spent: $unk_rows calls from $unk_keys keys in 7 days"); }
fact="$keys active keys"
if [ ${#why[@]} -gt 0 ]; then fact+=", $(IFS=';'; echo "${why[*]}" | sed 's/;/; /g')"
else fact+=", none outside its allowlist, none idle 30 days, no unknown spenders"; fi
fact+=", refused calls by inactive keys in 7 days: ${ref_all:-?} (${ref_del:-?} by deleted keys)"
check_emit "$NAME" "$status" "$fact, at $(check_now)" "$NEXT"
