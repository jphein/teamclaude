# shellcheck shell=bash
# Shared by the teamclaude CHECK scripts (docs/CHECKS.md). One line per run:
#   CHECK <name> <ok|warn|fail> · <fact, number, time> · <next/owner>
# printed to stdout (the journal) and kept as $CHECK_STATE_DIR/<name>.line, the fleet's canonical
# place (FOR-AGENTS rule 24: written as .tmp then renamed; Hearth › Checks and the 08:11 pass read
# it), with a short history in <name>.log. Exit 0 always: a check reports, it never gates.
check_emit() { # name status fact next
  local name=$1 status=$2 fact=$3 next=$4 dir line
  case $status in ok|warn|fail) ;; *) status=fail; fact="bad status from the check itself: $fact" ;; esac
  line="CHECK $name $status · $fact · $next"
  printf '%s\n' "$line"
  dir=${CHECK_STATE_DIR:-$HOME/.local/state/checks}
  if mkdir -p "$dir" 2>/dev/null; then
    printf '%s\n' "$line" > "$dir/$name.line.tmp" && mv -f "$dir/$name.line.tmp" "$dir/$name.line"
    printf '%s %s\n' "$(date -Iseconds)" "$line" >> "$dir/$name.log"
    # keep the history short: about 3 weeks at 15-minute runs
    if [ "$(wc -l < "$dir/$name.log")" -gt 2500 ]; then
      tail -n 2000 "$dir/$name.log" > "$dir/$name.log.tmp" && mv -f "$dir/$name.log.tmp" "$dir/$name.log"
    fi
  fi
  exit 0
}
check_now() { date +%H:%M; }
