#!/usr/bin/env bash
# CHECK security-scan: exploits or bad code coming in from upstream or from our own processes, for teamclaude and
# the LiteLLM gateway, daily (JP 2026-11-23 18:3x via Sen, row f3fb83d4: "make sure we are scanning teamclaude and
# litellm all the time for any exploits or bad code coming in from upstream or our own tainted processes").
#   leaks     gitleaks over the whole history of teamclaude origin/master and forge-gateway origin/main, minus each
#             repo's committed .gitleaksignore (fingerprints, no values). Any finding: fail. Values never print.
#   audit     npm audit of teamclaude's lockfile on origin/master (no runtime deps: dev tools only). critical/high:
#             fail; moderate: warn; audit could not run: warn.
#   osv       the LiteLLM version pinned in forge-gateway's compose (`# vX.Y.Z` on the image line) against OSV.
#             A HIGH/CRITICAL advisory: fail; any other: warn; OSV unreachable: warn.
#   upstream  KarpelesLab/teamclaude commits not in the fork: the count, and the commits that are NEW since the
#             baseline this check keeps (each new one is a row: read its diff before any sync). warn on new ones.
#   PRs       an open PR that changes dependencies (teamclaude package*.json; forge-gateway compose/go.mod/go.sum)
#             or brings upstream commits in: warn until it merges (the row says: read the diff before the merge).
#   running   the VM's teamclaude checkout: HEAD on origin/master (else fail: unmerged code runs), no tracked or
#             untracked change under src/ bin/ package.json (else fail: tainted), no src file newer than the
#             running node (else warn: what runs is not what is on disk). LiteLLM, Postgres and Redis containers
#             on ubox0 run exactly the digests pinned in compose (else fail).
# Every warn/fail finding becomes a Flow row the same day, once per finding (state: security-scan.filed).
# Inputs (tests): CHECK_SCAN_FIXTURES (a dir of recorded probe outputs, read instead of running the probes),
#   CHECK_SCAN_FLOW (the command that files a row; default `flow --who teamclaude order teamclaude`).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME=security-scan
NEXT="findings are Flow rows · next run tomorrow 06:40 · owner teamclaude lane"
FX=${CHECK_SCAN_FIXTURES:-}
TC=${CHECK_SCAN_TC_REPO:-$HOME/Projects/teamclaude}
FG=${CHECK_SCAN_FG_REPO:-$HOME/Projects/forge-gateway}
VM=${CHECK_SCAN_VM:-jp@10.0.6.145}
DIR=${CHECK_STATE_DIR:-$HOME/.local/state/checks}
mkdir -p "$DIR" 2>/dev/null
tmp=$(mktemp -d) || check_emit "$NAME" fail "cannot make a temp dir at $(check_now)" "$NEXT"
trap 'rm -rf -- "$tmp"' EXIT
noproxy() { env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY "$@"; }
# a probe's output: the fixture when testing, else the live command
probe() { local name=$1; shift; if [ -n "$FX" ]; then cat "$FX/$name" 2>/dev/null; else "$@"; fi; }
clean() { tr -c 'A-Za-z0-9._:/#@+=,() \n-' '?' | tr '\n' ' ' | sed 's/ *$//'; }   # nothing odd reaches the line

status=ok; facts=(); finds=()   # finds: "key<TAB>row text"
bump() { case $1 in fail) status=fail ;; warn) [ "$status" = fail ] || status=warn ;; esac; }
find_() { finds+=("$1"$'\t'"$2"); }

[ -n "$FX" ] || { git -C "$TC" fetch -q origin 2>/dev/null; git -C "$TC" fetch -q upstream 2>/dev/null; git -C "$FG" fetch -q origin 2>/dev/null; }

# ---- leaks
leaks() { # repo ref -> gitleaks JSON report (redacted) on stdout
  local ign="$tmp/ign.$RANDOM"
  git -C "$1" show "$2:.gitleaksignore" > "$ign" 2>/dev/null || : > "$ign"
  noproxy timeout 600 ionice -c3 nice -n 15 gitleaks git --redact --no-banner --log-opts="$2" --gitleaks-ignore-path "$ign" \
    --report-format json --report-path "$tmp/gl.json" "$1" >/dev/null 2>&1
  [ $? -le 1 ] && cat "$tmp/gl.json"
}
for pair in "teamclaude:$TC:origin/master" "forge-gateway:$FG:origin/main"; do
  repo=${pair%%:*}; rest=${pair#*:}; path=${rest%%:*}; ref=${rest#*:}
  out=$(probe "gitleaks-$repo.json" leaks "$path" "$ref")
  if ! n=$(jq -er 'length' <<<"$out" 2>/dev/null); then bump warn; facts+=("$repo gitleaks did not run"); continue; fi
  if [ "$n" -gt 0 ]; then
    bump fail; facts+=("$repo gitleaks $n: $(jq -r '[.[] | "\(.RuleID) \(.File)"] | unique | join(", ")' <<<"$out" | clean)")
    while IFS=$'\t' read -r fp what; do find_ "leak:$repo:$fp" "security-scan: gitleaks found $what in $repo main history: rotate if real, else add its fingerprint to .gitleaksignore"; done \
      < <(jq -r '.[] | "\(.Fingerprint)\t\(.RuleID) at \(.File):\(.StartLine) (\(.Commit[0:7]))"' <<<"$out" | tr -c 'A-Za-z0-9._:/@()\t\n -' '?')
  else facts+=("$repo gitleaks 0"); fi
done

# ---- audit (teamclaude dev tools)
audit() {
  # master keeps no lockfile: resolve one the way CI's install would (no scripts run, nothing installed)
  mkdir -p "$tmp/audit" && git -C "$TC" show origin/master:package.json > "$tmp/audit/package.json" \
    && (cd "$tmp/audit" && noproxy timeout 180 npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 \
        && noproxy timeout 120 npm audit --package-lock-only --json 2>/dev/null)
}
out=$(probe audit.json audit)
if v=$(jq -er '.metadata.vulnerabilities | "\(.critical // 0) \(.high // 0) \(.moderate // 0)"' <<<"$out" 2>/dev/null); then
  read -r crit high mod <<<"$v"
  names=$(jq -r '[.vulnerabilities // {} | to_entries[] | select(.value.severity == "critical" or .value.severity == "high" or .value.severity == "moderate") | "\(.key)(\(.value.severity))"] | join(" ")' <<<"$out" | clean)
  if [ $((crit + high)) -gt 0 ]; then bump fail; elif [ "$mod" -gt 0 ]; then bump warn; fi
  facts+=("npm audit $crit critical $high high $mod moderate${names:+ ($names)}")
  for p in $names; do find_ "audit:$p" "security-scan: npm audit flags $p in teamclaude's dev tools on master: bump or pin it"; done
else bump warn; facts+=("npm audit did not run"); fi

# ---- osv (the LiteLLM version the compose pins)
compose=$(probe compose.yaml git -C "$FG" show origin/main:deploy/compose.yaml)
ver=$(grep -E 'image: *ghcr.io/berriai/litellm[^ ]*@sha256:' <<<"$compose" | grep -oE '# *v[0-9]+(\.[0-9]+)+' | head -1 | grep -oE '[0-9]+(\.[0-9]+)+')
if [ -z "$ver" ]; then bump warn; facts+=("litellm version not found in compose")
else
  out=$(probe osv.json noproxy curl -q -s -f --max-time 30 -H 'Content-Type: application/json' \
    -d "{\"package\":{\"name\":\"litellm\",\"ecosystem\":\"PyPI\"},\"version\":\"$ver\"}" https://api.osv.dev/v1/query)
  if ids=$(jq -er '[.vulns // [] | .[] | .id] | join(" ")' <<<"$out" 2>/dev/null); then
    hi=$(jq -r '[.vulns // [] | .[] | select(((.database_specific.severity // "") | ascii_upcase) as $s | $s == "HIGH" or $s == "CRITICAL") | .id] | join(" ")' <<<"$out")
    ids=$(clean <<<"$ids"); hi=$(clean <<<"$hi")
    if [ -n "$hi" ]; then bump fail; elif [ -n "$ids" ]; then bump warn; fi
    facts+=("litellm $ver OSV ${ids:-0}${hi:+ (high: $hi)}")
    for id in $ids; do find_ "osv:litellm:$ver:$id" "security-scan: OSV $id affects LiteLLM $ver (forge-gateway pin): read it; bump the pinned digest if it applies"; done
  else bump warn; facts+=("litellm $ver OSV did not answer"); fi
fi

# ---- upstream (KarpelesLab commits not in the fork)
up=$(probe upstream.txt git -C "$TC" rev-list origin/master..upstream/master)
if [ -z "$FX" ] && ! git -C "$TC" rev-parse -q --verify upstream/master >/dev/null; then bump warn; facts+=("upstream not fetched")
else
  base="$DIR/$NAME.upstream-seen"
  total=$(grep -c . <<<"$up")
  if [ ! -s "$base" ]; then printf '%s\n' "$up" > "$base"; facts+=("upstream $total commits not in the fork (baseline recorded)")
  else
    new=$(grep -vxF -f "$base" <<<"$up" | grep .)
    if [ -n "$new" ]; then
      bump warn; facts+=("upstream $total not in the fork, $(grep -c . <<<"$new") new since the last run")
      for c in $new; do
        subj=$(probe "subject-$c" git -C "$TC" log -1 --format=%s "$c" | head -c 100 | clean)
        find_ "upstream:$c" "security-scan: upstream teamclaude ${c:0:9} \"$subj\" is new: read its diff before any sync into the fork"
      done
      printf '%s\n' "$up" > "$base"
    else facts+=("upstream $total not in the fork, 0 new"); fi
  fi
fi

# ---- open PRs that change dependencies or bring upstream code in
prs() { # owner/repo -> "number<TAB>file" lines for every open PR
  local n
  for n in $(gh api "repos/$1/pulls?state=open&per_page=50" --jq '.[].number' 2>/dev/null); do
    gh api "repos/$1/pulls/$n/files?per_page=100" --jq ".[] | \"$n\t\(.filename)\"" 2>/dev/null
  done
}
for pair in "teamclaude:jphein/teamclaude:^(package[.]json|package-lock[.]json)$" "forge-gateway:jphein/forge-gateway:^(deploy/compose[.]yaml|go[.]mod|go[.]sum)$"; do
  repo=${pair%%:*}; rest=${pair#*:}; slug=${rest%%:*}; pat=${rest#*:}
  hits=$(probe "prs-$repo.txt" prs "$slug" | awk -F'\t' -v p="$pat" '$2 ~ p {print $1}' | sort -un | tr '\n' ' ' | sed 's/ $//')
  if [ -n "$hits" ]; then
    bump warn; facts+=("$repo dependency PRs open: $(sed 's/[0-9]\+/#&/g' <<<"$hits")")
    for n in $hits; do find_ "pr:$repo:$n" "security-scan: $slug PR $n changes dependencies: read the upstream diff of each bump before it merges"; done
  fi
done
if [ -n "$FX" ]; then upr=$(cat "$FX/upstream-prs.txt" 2>/dev/null)
else upr=$(for n in $(gh api "repos/jphein/teamclaude/pulls?state=open&per_page=50" --jq '.[].number' 2>/dev/null); do
  gh api "repos/jphein/teamclaude/pulls/$n/commits?per_page=250" --jq '.[].sha' 2>/dev/null | while read -r s; do
    git -C "$TC" merge-base --is-ancestor "$s" upstream/master 2>/dev/null && { echo "$n"; break; }; done; done); fi
for n in $(sort -un <<<"$upr"); do
  bump warn; facts+=("teamclaude PR #$n brings upstream commits")
  find_ "upr:$n" "security-scan: jphein/teamclaude PR $n brings upstream commits in: read the whole upstream diff before it merges"
done

# ---- running vs repo
vm() {
  # the node's start time comes from /proc/<pid>/stat field 22 (clock ticks after boot) + btime: the /proc/<pid>
  # directory's own mtime is when procfs made the inode, which can be later than the start
  timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=8 "$VM" sh -s 2>/dev/null <<'EOS'
cd ~/teamclaude || exit 1
echo "HEAD $(git rev-parse HEAD)"
git status --porcelain --untracked-files=all -- src bin package.json | sed 's/^/DIRTY /'
pid=$(pgrep -f 'src/index.js server' | head -1)
if [ -n "$pid" ]; then
  bt=$(awk '$1 == "btime" {print $2}' /proc/stat)
  st=$(sed 's/.*) //' "/proc/$pid/stat" | awk '{print $20}')
  start=$((bt + st / 100))
  echo "START $start"
  find src bin -type f -exec stat -c '%Y %n' {} + 2>/dev/null | awk -v s="$start" '$1 > s {print "NEWER", $2}'
fi
echo "NODE $(/opt/node/bin/node --version 2>/dev/null)"
EOS
}
out=$(probe vm.txt vm)
head_=$(awk '$1 == "HEAD" {print $2}' <<<"$out" | grep -E '^[0-9a-f]{40}$')
if [ -z "$head_" ]; then bump warn; facts+=("VM checkout unreadable")
else
  dirty=$(awk '$1 == "DIRTY" {print $NF}' <<<"$out" | clean); newer=$(awk '$1 == "NEWER" {print $2}' <<<"$out" | clean)
  onmain=yes
  if [ -n "$FX" ]; then grep -qx "$head_" "$FX/master-commits.txt" 2>/dev/null || onmain=no
  else git -C "$TC" merge-base --is-ancestor "$head_" origin/master 2>/dev/null || onmain=no; fi
  f="VM ${head_:0:7} $(awk '$1 == "NODE" {print $2}' <<<"$out" | clean)"; f0=$f
  if [ "$onmain" = no ]; then bump fail; f+=" NOT on master"; find_ "vm:head:$head_" "security-scan: the VM proxy runs ${head_:0:9}, which is not on origin/master: find who deployed it, then deploy a merged commit"; fi
  if [ -n "$dirty" ]; then bump fail; f+=" tainted: $dirty"; find_ "vm:dirty:$(md5sum <<<"$dirty" | cut -c1-12)" "security-scan: the VM teamclaude checkout has changes under src/bin/package.json not in git ($dirty): read them, then restore the merged commit"; fi
  if [ -n "$newer" ]; then bump warn; f+=" src newer than the running node: $newer"; find_ "vm:newer:$(md5sum <<<"$newer" | cut -c1-12)" "security-scan: VM src changed after the proxy started ($newer): what runs is not what is on disk; restart it with notice"; fi
  [ "$f" = "$f0" ] && f+=" clean, on master"
  facts+=("$f")
fi
pins=$(grep -oE 'image: *[^ ]+@sha256:[0-9a-f]{64}' <<<"$compose" | sed -E 's/image: *//')
run=$(probe docker.txt timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=8 ubox0 \
  "docker inspect --format '{{.Name}} {{.Config.Image}}' \$(docker ps -q --filter name=forge-) 2>/dev/null")
if [ -z "$pins" ] || [ -z "$run" ]; then bump warn; facts+=("forge containers or pins unreadable")
else
  bad=""
  while read -r cname cimg; do
    [ -n "$cname" ] || continue
    grep -qxF "$cimg" <<<"$pins" || bad+="${cname#/}=${cimg##*@sha256:} "
  done <<<"$run"
  bad=$(clean <<<"${bad:0:200}")
  if [ -n "$bad" ]; then bump fail; facts+=("forge containers off their pins: $bad")
    find_ "image:$(md5sum <<<"$bad" | cut -c1-12)" "security-scan: ubox0 forge containers run images not pinned in forge-gateway compose ($bad): find who pulled them; redeploy the pinned digests"
  else facts+=("forge $(grep -c . <<<"$run") containers on their pins"); fi
fi

# ---- findings become rows, once each
filed="$DIR/$NAME.filed"; touch "$filed" 2>/dev/null
nf=0; failed_rows=0
for item in "${finds[@]}"; do
  key=${item%%$'\t'*}; text=${item#*$'\t'}
  grep -qxF "$key" "$filed" 2>/dev/null && continue
  if [ -n "${CHECK_SCAN_FLOW:-}" ]; then $CHECK_SCAN_FLOW "$text" >/dev/null 2>&1; else flow --who teamclaude order teamclaude "$text" >/dev/null 2>&1; fi \
    && { printf '%s\n' "$key" >> "$filed"; nf=$((nf + 1)); } || failed_rows=$((failed_rows + 1))
done
[ "$failed_rows" -gt 0 ] && { bump warn; facts+=("$failed_rows rows could not be filed (retried next run)"); }
fact=$(IFS=';'; echo "${facts[*]}" | sed 's/;/; /g')
check_emit "$NAME" "$status" "$fact; rows filed $nf, at $(check_now)" "$NEXT"
