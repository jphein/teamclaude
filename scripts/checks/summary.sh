#!/usr/bin/env bash
# The daily line's input: every check that is not ok, and every check whose last line is older than
# twice its cadence (a timer that stopped is itself a warn: stale data must not look quiet).
# Prints nothing when all checks are ok and fresh. Exit 0 always.
# Inputs (tests): CHECK_STATE_DIR, CHECK_NOW (epoch seconds).
dir=${CHECK_STATE_DIR:-$HOME/.local/state/checks}
now=${CHECK_NOW:-$(date +%s)}
# name:max age in minutes (twice the cadence)
for spec in pool-quota:30 proxy-wrapper:30 forge-keys:2880; do
  name=${spec%%:*} max=${spec##*:}; f="$dir/$name.last"
  if [ ! -s "$f" ]; then echo "CHECK $name warn · no result yet (timer not run or not installed) · owner teamclaude lane"; continue; fi
  age=$(( (now - $(stat -c %Y "$f")) / 60 ))
  line=$(head -n 1 "$f")
  # one line of the full shape, or it is not a result
  if [ "$(grep -c '' "$f")" != 1 ] || [[ ! "$line" =~ ^CHECK\ $name\ (ok|warn|fail)\ ·\ .+\ ·\ .+$ ]]; then
    echo "CHECK $name warn · last result is malformed; look at $f · owner teamclaude lane"
  elif [ "$age" -gt "$max" ]; then echo "CHECK $name warn · last result is $age min old (max $max): timer stopped? last: ${line#CHECK $name } · owner teamclaude lane"
  else case $line in "CHECK $name ok · "*) ;; *) echo "$line" ;; esac; fi
done
exit 0
