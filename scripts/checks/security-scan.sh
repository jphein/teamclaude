#!/usr/bin/env bash
# CHECK security-scan: exploits or bad code coming in from upstream or from our own processes, for teamclaude and
# the LiteLLM gateway, daily (JP 2026-11-23 18:3x via Sen, row f3fb83d4: "make sure we are scanning teamclaude and
# litellm all the time for any exploits or bad code coming in from upstream or our own tainted processes").
# A probe that cannot see is never a clean result: a blind scanner (gitleaks, npm audit, OSV) fails; a failed
# fetch, an unreadable VM, ubox0 or PR list warns. (xreview round 1, Sen 2026-11-23 18:59.)
#   fetch     teamclaude origin + upstream, forge-gateway origin. Any failure: warn (the compares below then use
#             the last fetched refs, and the line says so).
#   leaks     gitleaks over teamclaude origin/master and forge-gateway origin/main history, minus each repo's
#             committed .gitleaksignore (fingerprints, no values). Any finding: fail; gitleaks errored: fail.
#   audit     npm audit of teamclaude's dev tools (no runtime deps), lockfile resolved in a temp dir with no
#             scripts run. Its exit status and its JSON must agree (0 = no advisories, 1 = some); critical/high:
#             fail; moderate: warn; an error, a disagreement or malformed JSON: fail.
#   osv       OSV advisories for the LiteLLM version pinned in forge-gateway's compose (`# vX.Y.Z` on the image
#             line). ANY advisory fails (no severity mapping can under-classify it; the row says which);
#             unreachable, non-zero or malformed: fail.
#   upstream  KarpelesLab/teamclaude commits not in the fork that are new since the baseline: warn, one row
#             each, the SHA only (a commit's own text is outside input and never enters a work order). A commit
#             joins the baseline only once its row is filed.
#   PRs       open PRs that change dependencies (teamclaude package*.json; forge-gateway compose/go.mod/go.sum)
#             or bring upstream commits in, every list paginated; a PR the API cannot list in full counts as one.
#             warn until it merges; a list that cannot be read: warn.
#   running   the VM's teamclaude files: the sha256 of every file under src/ and bin/ and package.json, read
#             on the VM, must equal the tree of the merged commit the VM names (fail: tainted or unmerged); no
#             such file newer than the running node (warn: what runs is not what is on disk). The forge
#             containers on ubox0 must run images whose runtime RepoDigests (or image id) are the digests pinned
#             in compose (fail).
# Every warn/fail finding becomes a Flow row the same day, once per finding (state: security-scan.filed).
# Inputs (tests): CHECK_SCAN_FIXTURES (a dir; a probe whose file is there is read from it, any other runs live),
#   CHECK_SCAN_FLOW (files a row), CHECK_SCAN_TC_REPO, CHECK_SCAN_FG_REPO, CHECK_SCAN_VM_RUN and
#   CHECK_SCAN_DOCKER_RUN (commands that run a script read on stdin; default ssh), CHECK_SCAN_VM_DIR.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME=security-scan
NEXT="findings are Flow rows · next run tomorrow 06:40 · owner teamclaude lane"
FX=${CHECK_SCAN_FIXTURES:-}
TC=${CHECK_SCAN_TC_REPO:-$HOME/Projects/teamclaude}
FG=${CHECK_SCAN_FG_REPO:-$HOME/Projects/forge-gateway}
VM_RUN=${CHECK_SCAN_VM_RUN:-timeout 90 ssh -o BatchMode=yes -o ConnectTimeout=8 jp@10.0.6.145 sh -s --}
VM_DIR=${CHECK_SCAN_VM_DIR:-teamclaude}
DOCKER_RUN=${CHECK_SCAN_DOCKER_RUN:-timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=8 ubox0 sh -s --}
DIR=${CHECK_STATE_DIR:-$HOME/.local/state/checks}
mkdir -p "$DIR" 2>/dev/null
tmp=$(mktemp -d) || check_emit "$NAME" fail "cannot make a temp dir at $(check_now)" "$NEXT"
trap 'rm -rf -- "$tmp"' EXIT
noproxy() { env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY "$@"; }
# a probe's output: its fixture when one is recorded, else the live command
probe() { local name=$1; shift; if [ -n "$FX" ] && [ -e "$FX/$name" ]; then cat "$FX/$name"; else "$@"; fi; }
clean() { tr -c 'A-Za-z0-9._:/#@+=,() \n-' '?' | tr '\n' ' ' | sed 's/ *$//'; }   # nothing odd reaches the line
rc_of() { sed -n 's/^#RC //p' | tail -1; }    # probes end their output with "#RC <exit status>"
body_of() { grep -v '^#RC '; }

status=ok; facts=(); finds=()   # finds: "key<TAB>row text"
bump() { case $1 in fail) status=fail ;; warn) [ "$status" = fail ] || status=warn ;; esac; }
find_() { finds+=("$1"$'\t'"$2"); }
# A probe that could not see: its warn/fail AND a row, keyed per probe. The key is dropped from the filed list on
# a run where that probe sees again, so the next outage files a new row (xreview round 2, point 6).
blind=0
blind() { # warn|fail probe-key fact
  bump "$1"; facts+=("$3"); blind=1
  find_ "blind:$2" "security-scan could not see: $3. Fix the probe; until then that part of the scan is unknown, not clean"
}

# ---- fetch
do_fetch() {
  local spec
  for spec in "teamclaude $TC origin" "upstream $TC upstream" "forge-gateway $FG origin"; do
    # shellcheck disable=SC2086
    set -- $spec
    noproxy timeout 120 git -C "$2" fetch -q "$3" >/dev/null 2>&1; echo "$1 $?"
  done
}
out=$(probe fetch.txt do_fetch)
stale=""
for r in teamclaude upstream forge-gateway; do grep -qx "$r 0" <<<"$out" || stale+="$r "; done
stale=${stale% }
[ -n "$stale" ] && blind warn fetch "fetch failed: $stale (compared against the last fetched refs)"

# ---- leaks
leaks() { # repo ref -> the redacted gitleaks JSON report, then "#RC n"
  local ign="$tmp/ign.$RANDOM" rc
  git -C "$1" show "$2:.gitleaksignore" > "$ign" 2>/dev/null || : > "$ign"
  rm -f "$tmp/gl.json"
  noproxy timeout 600 ionice -c3 nice -n 15 gitleaks git --redact --no-banner --log-opts="$2" --gitleaks-ignore-path "$ign" \
    --report-format json --report-path "$tmp/gl.json" "$1" >/dev/null 2>&1
  rc=$?
  cat "$tmp/gl.json" 2>/dev/null; echo; echo "#RC $rc"
}
for pair in "teamclaude:$TC:origin/master" "forge-gateway:$FG:origin/main"; do
  repo=${pair%%:*}; rest=${pair#*:}; path=${rest%%:*}; ref=${rest#*:}
  out=$(probe "gitleaks-$repo.json" leaks "$path" "$ref"); rc=$(rc_of <<<"$out"); body=$(body_of <<<"$out")
  # gitleaks exits 0 with no leaks and 1 with leaks; anything else, or a report that is not an array, is blind
  if { [ "$rc" != 0 ] && [ "$rc" != 1 ]; } || ! n=$(jq -er 'if type == "array" then length else error end' <<<"$body" 2>/dev/null) \
     || { [ "$rc" = 0 ] && [ "$n" -gt 0 ]; } || { [ "$rc" = 1 ] && [ "$n" = 0 ]; }; then
    blind fail "gitleaks:$repo" "$repo gitleaks could not scan (exit ${rc:-?})"; continue
  fi
  if [ "$n" -gt 0 ]; then
    bump fail; facts+=("$repo gitleaks $n: $(jq -r '[.[] | "\(.RuleID) \(.File)"] | unique | join(", ")' <<<"$body" | clean)")
    while IFS=$'\t' read -r fp what; do find_ "leak:$repo:$fp" "security-scan: gitleaks found $what in $repo main history: rotate if real, else add its fingerprint to .gitleaksignore"; done \
      < <(jq -r '.[] | "\(.Fingerprint)\t\(.RuleID) at \(.File):\(.StartLine) (\(.Commit[0:7]))"' <<<"$body" | tr -c 'A-Za-z0-9._:/@()\t\n -' '?')
  else facts+=("$repo gitleaks 0"); fi
done

# ---- audit (teamclaude dev tools)
audit() { # -> npm audit JSON, then "#RC n" ("#RC install-n" when the lockfile could not be resolved)
  # master keeps no lockfile on purpose: CI runs `npm install --ignore-scripts` with none (.github/workflows/ci.yml,
  # "there is no lockfile for npm ci to consume"), so the graph CI tests is a fresh resolution of package.json,
  # and that is the graph audited here, resolved the same way.
  local rc
  mkdir -p "$tmp/audit"
  git -C "$TC" show origin/master:package.json > "$tmp/audit/package.json" 2>/dev/null || { echo "#RC show-1"; return; }
  (cd "$tmp/audit" && noproxy timeout 180 npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) \
    || { echo "#RC install-$?"; return; }
  (cd "$tmp/audit" && noproxy timeout 120 npm audit --package-lock-only --json 2>/dev/null); rc=$?
  echo; echo "#RC $rc"
}
out=$(probe audit.json audit); rc=$(rc_of <<<"$out"); body=$(body_of <<<"$out")
v=$(jq -er '.metadata.vulnerabilities | [.critical, .high, .moderate, .total] | if all(type == "number") then map(tostring) | join(" ") else error end' <<<"$body" 2>/dev/null)
read -r crit high mod total <<<"${v:-x x x x}"
if [ -z "$v" ] || { [ "$rc" != 0 ] && [ "$rc" != 1 ]; } || { [ "$rc" = 0 ] && [ "$total" != 0 ]; } || { [ "$rc" = 1 ] && [ "$total" = 0 ]; }; then
  blind fail audit "npm audit could not be read (exit ${rc:-?})"
else
  names=$(jq -r '[.vulnerabilities // {} | to_entries[] | select(.value.severity == "critical" or .value.severity == "high" or .value.severity == "moderate") | "\(.key)(\(.value.severity))"] | join(" ")' <<<"$body" | clean)
  if [ $((crit + high)) -gt 0 ]; then bump fail; elif [ "$mod" -gt 0 ]; then bump warn; fi
  facts+=("npm audit $crit critical $high high $mod moderate${names:+ ($names)}")
  for p in $names; do find_ "audit:$p" "security-scan: npm audit flags $p in teamclaude's dev tools on master: bump or pin it"; done
  # counts with no named package still file a row: no warn or fail goes without one
  [ -z "$names" ] && [ $((crit + high + mod)) -gt 0 ] && find_ "audit:counts:$crit-$high-$mod" "security-scan: npm audit counts $crit critical $high high $mod moderate in teamclaude's dev tools, packages unnamed: run npm audit by hand"
fi

# ---- osv (the LiteLLM version the compose pins)
compose=$(probe compose.yaml git -C "$FG" show origin/main:deploy/compose.yaml)
ver=$(grep -E 'image: *ghcr.io/berriai/litellm[^ ]*@sha256:' <<<"$compose" | grep -oE '# *v[0-9]+(\.[0-9]+)+' | head -1 | grep -oE '[0-9]+(\.[0-9]+)+')
osv() {
  local rc
  noproxy curl -q -s -f --max-time 30 -H 'Content-Type: application/json' \
    -d "{\"package\":{\"name\":\"litellm\",\"ecosystem\":\"PyPI\"},\"version\":\"$1\"}" https://api.osv.dev/v1/query; rc=$?
  echo; echo "#RC $rc"
}
if [ -z "$ver" ]; then blind fail osv-version "litellm version not found in compose: OSV not asked"
else
  out=$(probe osv.json osv "$ver"); rc=$(rc_of <<<"$out"); body=$(body_of <<<"$out")
  # OSV answers a version with no advisory as {} with NO vulns key (measured 2026-11-24: litellm 1.106.9 -> {};
  # 1.40.0 -> {"vulns":[60 items]}), so an absent key is zero. A vulns key that is present must be an array:
  # null or anything else is malformed, as is anything that is not an object.
  if [ "$rc" != 0 ] || ! ids=$(jq -er 'if type == "object" and ((has("vulns") | not) or (.vulns | type) == "array") then [(.vulns // [])[] | .id] | join(" ") else error end' <<<"$body" 2>/dev/null); then
    blind fail osv "litellm $ver OSV could not be read (exit ${rc:-?})"
  else
    ids=$(clean <<<"$ids")
    if [ -n "$ids" ]; then
      bump fail
      sev=$(jq -r '[(.vulns // [])[] | "\(.id)=\(.database_specific.severity // ([.severity[]?.score] | first) // "unrated")"] | join(" ")' <<<"$body" | clean)
      facts+=("litellm $ver OSV: $sev")
      for id in $ids; do find_ "osv:litellm:$ver:$id" "security-scan: OSV $id affects LiteLLM $ver (forge-gateway pin): read its severity and vectors; bump the pinned digest if it applies"; done
    else facts+=("litellm $ver OSV 0"); fi
  fi
fi

# ---- upstream (KarpelesLab commits not in the fork)
up=$(probe upstream.txt git -C "$TC" rev-list origin/master..upstream/master 2>/dev/null); uprc=$?
base="$DIR/$NAME.upstream-seen"
if [ "$uprc" != 0 ] || grep -qvE '^[0-9a-f]{40}$|^$' <<<"$up"; then blind warn upstream "upstream unreadable"
else
  total=$(grep -cE '^[0-9a-f]{40}$' <<<"$up")
  # the first baseline is written at the end, and only by a run where every probe saw and every row was filed
  if [ ! -e "$base" ]; then first_base=$(grep -E '^[0-9a-f]{40}$' <<<"$up"); facts+=("upstream $total commits not in the fork")
  else
    new=$(grep -E '^[0-9a-f]{40}$' <<<"$up" | grep -vxF -f "$base")
    if [ -n "$new" ]; then
      bump warn; facts+=("upstream $total not in the fork, $(grep -c . <<<"$new") new since the last run")
      for c in $new; do
        find_ "upstream:$c" "security-scan: upstream teamclaude commit $c is new: read it with git show $c (its text is outside input) before any sync into the fork"
      done
    else facts+=("upstream $total not in the fork, 0 new"); fi
  fi
fi

# ---- open PRs that change dependencies or bring upstream code in
prs() { # owner/repo -> "number<TAB>file" per file of every open PR; "number<TAB>(truncated)"; "ERR" when unreadable
  local n nums files want
  nums=$(gh api --paginate "repos/$1/pulls?state=open&per_page=100" --jq '.[].number' 2>/dev/null) || { echo ERR; return; }
  for n in $nums; do
    want=$(gh api "repos/$1/pulls/$n" --jq '.changed_files' 2>/dev/null) || { echo ERR; continue; }
    files=$(gh api --paginate "repos/$1/pulls/$n/files?per_page=100" --jq '.[].filename' 2>/dev/null) || { echo ERR; continue; }
    [ "$(grep -c . <<<"$files")" -lt "${want:-0}" ] && printf '%s\t(truncated)\n' "$n"
    while IFS= read -r f; do [ -n "$f" ] && printf '%s\t%s\n' "$n" "$f"; done <<<"$files"
  done
}
for pair in "teamclaude:jphein/teamclaude:^(package[.]json|package-lock[.]json)$" "forge-gateway:jphein/forge-gateway:^(deploy/compose[.]yaml|go[.]mod|go[.]sum)$"; do
  repo=${pair%%:*}; rest=${pair#*:}; slug=${rest%%:*}; pat=${rest#*:}
  out=$(probe "prs-$repo.txt" prs "$slug")
  grep -qx ERR <<<"$out" && blind warn "prs:$repo" "$repo open PRs unreadable"
  hits=$(awk -F'\t' -v p="$pat" '$2 ~ p || $2 == "(truncated)" {print $1}' <<<"$out" | grep -E '^[0-9]+$' | sort -un | tr '\n' ' ' | sed 's/ $//')
  if [ -n "$hits" ]; then
    bump warn; facts+=("$repo dependency PRs open: $(sed 's/[0-9]\+/#&/g' <<<"$hits")")
    for n in $hits; do find_ "pr:$repo:$n" "security-scan: $slug PR $n changes dependencies (or has more files than the API lists): read the upstream diff of each bump before it merges"; done
  fi
done
upstream_prs() { # PR numbers whose commits include an upstream commit (or cannot all be listed); "ERR" when unreadable
  local n nums shas want
  nums=$(gh api --paginate "repos/jphein/teamclaude/pulls?state=open&per_page=100" --jq '.[].number' 2>/dev/null) || { echo ERR; return; }
  for n in $nums; do
    want=$(gh api "repos/jphein/teamclaude/pulls/$n" --jq '.commits' 2>/dev/null) || { echo ERR; continue; }
    shas=$(gh api --paginate "repos/jphein/teamclaude/pulls/$n/commits?per_page=100" --jq '.[].sha' 2>/dev/null) || { echo ERR; continue; }
    # the commits endpoint stops at 250: a longer PR counts as bringing upstream in until read by hand
    if [ "$(grep -c . <<<"$shas")" -lt "${want:-0}" ]; then echo "$n"; continue; fi
    while read -r s; do
      [ -n "$s" ] && git -C "$TC" merge-base --is-ancestor "$s" upstream/master 2>/dev/null && { echo "$n"; break; }
    done <<<"$shas"
  done
}
upr=$(probe upstream-prs.txt upstream_prs)
grep -qx ERR <<<"$upr" && blind warn upstream-prs "teamclaude upstream-PR check unreadable"
for n in $(grep -E '^[0-9]+$' <<<"$upr" | sort -un); do
  bump warn; facts+=("teamclaude PR #$n brings upstream commits")
  find_ "upr:$n" "security-scan: jphein/teamclaude PR $n brings upstream commits in (or has more than the API lists): read the whole upstream diff before it merges"
done

# ---- running vs repo: every file of the VM checkout, hashed where it runs, against the merged commit's tree
# The VM prints, for every file under its checkout except .git (dotfiles included), its git mode and blob id
# (git hash-object --no-filters: a hash of the bytes, not a read of the VM's index or HEAD); this side lists the same
# for the commit the VM names with git ls-tree -r. Any file added, removed, changed or re-moded is tainted.
vm() {
  # The node's start comes from /proc/<pid>/stat field 22 (ticks after boot) + btime: the /proc/<pid> directory's
  # own mtime is when procfs made the inode, which can be later than the start.
  $VM_RUN "$VM_DIR" <<'EOS'
cd "$1" 2>/dev/null || exit 1
echo "HEAD $(git rev-parse HEAD 2>/dev/null)"
pid=$(pgrep -f 'src/index.js server' 2>/dev/null | head -1)
start=""
if [ -n "$pid" ] && [ -r "/proc/$pid/stat" ]; then
  bt=$(awk '$1 == "btime" {print $2}' /proc/stat)
  st=$(sed 's/.*) //' "/proc/$pid/stat" | awk '{print $20}')
  start=$((bt + st / 100)); echo "START $start"
fi
find . -path ./.git -prune -o \( -type f -o -type l \) -print | sed 's|^\./||' | sort | while IFS= read -r p; do
  if [ -L "$p" ]; then m=120000; b=$(printf %s "$(readlink "$p")" | git hash-object --stdin)
  else if [ -x "$p" ]; then m=100755; else m=100644; fi; b=$(git hash-object --no-filters "$p"); fi
  echo "FILE $m $b $p"
  [ -n "$start" ] && [ ! -L "$p" ] && [ "$(stat -c %Y "$p")" -gt "$start" ] && echo "NEWER $p"
done
echo "NODE $( (/opt/node/bin/node --version || node --version) 2>/dev/null)"
EOS
}
expected_files() { # commit -> "FILE mode blob path" for every file of its tree
  git -C "$TC" ls-tree -r --full-tree "$1" 2>/dev/null | awk -F'\t' '{ split($1, a, " "); if (a[2] == "blob") print "FILE " a[1] " " a[3] " " $2 }'
}
out=$(probe vm.txt vm)
head_=$(awk '$1 == "HEAD" {print $2}' <<<"$out" | grep -E '^[0-9a-f]{40}$')
if [ -z "$head_" ] || ! grep -q '^FILE ' <<<"$out"; then blind warn vm "VM checkout unreadable"
else
  node=$(awk '$1 == "NODE" {print $2}' <<<"$out" | clean)
  f="VM ${head_:0:7}${node:+ $node}"; f0=$f
  if ! git -C "$TC" merge-base --is-ancestor "$head_" origin/master 2>/dev/null; then
    bump fail; f+=" NOT on master"
    find_ "vm:head:$head_" "security-scan: the VM proxy names commit $head_, which is not on origin/master: find who deployed it, then deploy a merged commit"
  elif ! want=$(expected_files "$head_") || [ -z "$want" ]; then
    blind fail vm-tree "VM ${head_:0:7}: its tree is unreadable here"; f+=" (tree unreadable)"
  else
    # path = everything after the third field, so a path with spaces stays whole
    diffs=$(diff <(grep '^FILE ' <<<"$out" | sort -k4) <(sort -k4 <<<"$want") \
      | awk '/^[<>] FILE / { $1 = $2 = $3 = $4 = ""; sub(/^ +/, ""); print }' | sort -u | head -20 | clean)
    if [ -n "$diffs" ]; then
      bump fail; f+=" tainted: $diffs"
      find_ "vm:files:$(md5sum <<<"$diffs" | cut -c1-12)" "security-scan: VM teamclaude files differ from merged commit ${head_:0:9} ($diffs): read the changes, then restore the merged tree"
    fi
  fi
  newer=$(awk '$1 == "NEWER" { $1 = ""; sub(/^ +/, ""); print }' <<<"$out" | head -20 | clean)
  if [ -n "$newer" ]; then bump warn; f+=" files newer than the running node: $newer"
    find_ "vm:newer:$(md5sum <<<"$newer" | cut -c1-12)" "security-scan: VM files changed after the proxy started ($newer): what runs is not what is on disk; restart it with notice"; fi
  [ "$f" = "$f0" ] && f+=" files = merged tree ($(grep -c '^FILE ' <<<"$out") files)"
  facts+=("$f")
fi

# ---- forge containers: each one's runtime digests against ITS OWN service's pin in compose
docker_probe() {
  $DOCKER_RUN <<'EOS'
for c in $(docker ps -q --filter name=forge-); do
  n=$(docker inspect -f '{{.Name}}' "$c"); id=$(docker inspect -f '{{.Image}}' "$c")
  s=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c")
  echo "$n ${s:--} $id $(docker image inspect -f '{{join .RepoDigests " "}}' "$id" 2>/dev/null)"
done
EOS
}
# "service image@sha256:..." for every service whose image is pinned by digest
# (a service line may carry a trailing comment: `  redis: # holds ...`; any other 2-space key starts a new service)
pins=$(awk '/^services:/ { s = 1; next } /^[^ #]/ { s = 0 } s && /^  [^ #]/ { svc = ""; if ($0 ~ /^  [A-Za-z0-9_.-]+: *(#.*)?$/) { svc = $1; sub(/:$/, "", svc) } }
            s && svc != "" && /^    image: *[^ ]+@sha256:[0-9a-f]{64}/ { print svc, $2 }' <<<"$compose")
run=$(probe docker.txt docker_probe | grep '^/')
if [ -z "$pins" ] || [ -z "$run" ]; then blind warn docker "forge containers or pins unreadable"
else
  bad=""
  while read -r cname svc cid rds; do
    pin=$(awk -v s="$svc" '$1 == s {print $2}' <<<"$pins")
    ok=no
    if [ -n "$pin" ] && [ "$(grep -c . <<<"$pin")" = 1 ]; then   # no pin, or two for one service: not a match
      for d in $rds; do [ "$d" = "$pin" ] && ok=yes; done
      [ "${pin##*@}" = "$cid" ] && ok=yes   # an image store whose image id is the manifest digest
    fi
    [ "$ok" = yes ] || bad+="${cname#/}(${svc})=${cid#sha256:} "
  done <<<"$run"
  bad=$(cut -c1-200 <<<"$bad" | clean)
  if [ -n "$bad" ]; then bump fail; facts+=("forge containers off their service's pin: $bad")
    find_ "image:$(md5sum <<<"$bad" | cut -c1-12)" "security-scan: ubox0 forge containers run images that are not their own service's pinned digest in forge-gateway compose ($bad): find who pulled them; redeploy the pinned digests"
  else facts+=("forge $(grep -c . <<<"$run") containers on their service's pin"); fi
fi

# ---- findings become rows, once each
# An upstream commit joins the baseline only once its row is filed. A blind:* key leaves the filed list on a run
# where its probe saw again, so the next outage files a new row.
filed="$DIR/$NAME.filed"; touch "$filed" 2>/dev/null
nf=0; failed_rows=0; keys=""
for item in "${finds[@]}"; do
  key=${item%%$'\t'*}; text=${item#*$'\t'}; keys+="$key"$'\n'
  if ! grep -qxF "$key" "$filed" 2>/dev/null; then
    if [ -n "${CHECK_SCAN_FLOW:-}" ]; then $CHECK_SCAN_FLOW "$text" >/dev/null 2>&1; else flow --who teamclaude order teamclaude "$text" >/dev/null 2>&1; fi \
      && { printf '%s\n' "$key" >> "$filed"; nf=$((nf + 1)); } || { failed_rows=$((failed_rows + 1)); continue; }
  fi
  case $key in upstream:*) printf '%s\n' "${key#upstream:}" >> "$base" ;; esac
done
grep -v '^blind:' "$filed" > "$filed.tmp" 2>/dev/null; grep '^blind:' "$filed" 2>/dev/null | grep -xF -f <(printf '%s' "$keys" | grep '^blind:') >> "$filed.tmp"
mv -f "$filed.tmp" "$filed"
[ "$failed_rows" -gt 0 ] && { bump warn; facts+=("$failed_rows rows could not be filed (retried next run; this one cannot be a row)"); }
# the first upstream baseline: only from a run where every probe saw and every row was filed
if [ -n "${first_base+x}" ]; then
  if [ "$blind" = 0 ] && [ "$failed_rows" = 0 ]; then printf '%s\n' "$first_base" > "$base"; facts+=("upstream baseline recorded")
  else facts+=("upstream baseline not recorded: the run was incomplete"); fi
fi
fact=$(IFS=';'; echo "${facts[*]}" | sed 's/;/; /g')
check_emit "$NAME" "$status" "$fact; rows filed $nf, at $(check_now)" "$NEXT"
