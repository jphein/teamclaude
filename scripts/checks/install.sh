#!/usr/bin/env bash
# Install the teamclaude CHECK timers on familiar from a MERGED commit (never from a working tree):
#   scripts/checks/install.sh <commit>
# Every file is extracted into a staging directory and checked first; only a complete payload is
# published (scripts to ~/.local/libexec/teamclaude-checks/, units to ~/.config/systemd/user/), each
# file moved into place. A commit missing any file publishes nothing. The reviewed claude wrapper
# goes beside the scripts as the reference proxy-wrapper compares each host's wrapper against.
# Rollback: systemctl --user disable --now teamclaude-check-{pool-quota,proxy-wrapper,forge-keys}.timer
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: scripts/checks/install.sh <commit>" >&2; exit 22; }
cd "$(dirname "$0")/../.."
SYSTEMCTL=${CHECK_SYSTEMCTL:-systemctl}
sha=$(git rev-parse --verify "$1^{commit}")
git merge-base --is-ancestor "$sha" origin/master || { echo "install.sh: $1 is not on origin/master; merge first" >&2; exit 3; }
lib="$HOME/.local/libexec/teamclaude-checks"; units="$HOME/.config/systemd/user"
mkdir -p "$lib" "$units"
# one install at a time, for the whole run: a second one would publish while the first restarts timers
exec 8>"$lib/.install.lock"
flock -n 8 || { echo "install.sh: another install is running; nothing installed" >&2; exit 7; }
# On ANY exit after the timers were stopped (a refusal, a failed move, or an unexpected set -e
# failure such as a daemon-reload error) the timers are started again, unless the install finished.
quiesced=0 finished=0 timers=() was_running=()
cleanup() {
  # put the timers back as they were: stop all three (a failed `enable --now` may have started some),
  # then start only the ones that were running before this install
  if [ "$quiesced" = 1 ] && [ "$finished" = 0 ]; then
    $SYSTEMCTL --user stop "${timers[@]}" 2>/dev/null || true
    [ ${#was_running[@]} -eq 0 ] || $SYSTEMCTL --user start "${was_running[@]}" 2>/dev/null || true
  fi
  rm -rf -- "${stage:?}"
}
stage=$(mktemp -d "$lib/.stage.XXXXXX"); trap cleanup EXIT
mkdir "$stage/lib" "$stage/units"
scripts=(lib.sh pool-quota.sh proxy-probe.sh proxy-wrapper.sh forge-keys.sh summary.sh)
for f in "${scripts[@]}"; do
  git show "$sha:scripts/checks/$f" > "$stage/lib/$f" || { echo "install.sh: $f missing at $sha; nothing installed" >&2; exit 4; }
done
git show "$sha:scripts/claude-wrapper.sh" > "$stage/lib/claude-wrapper.sh" || { echo "install.sh: claude-wrapper.sh missing at $sha; nothing installed" >&2; exit 4; }
# exactly these six units, nothing more: an extra file is refused, not installed or enabled
checks=(pool-quota proxy-wrapper forge-keys)
want_units=(); timers=()
for n in "${checks[@]}"; do want_units+=("teamclaude-check-$n.service" "teamclaude-check-$n.timer"); timers+=("teamclaude-check-$n.timer"); done
have_units=$(git ls-tree --name-only "$sha" scripts/checks/systemd/ | xargs -rn1 basename | sort)
[ "$have_units" = "$(printf '%s\n' "${want_units[@]}" | sort)" ] \
  || { echo "install.sh: scripts/checks/systemd/ at $sha is not exactly the six check units; nothing installed" >&2; exit 4; }
for b in "${want_units[@]}"; do
  git show "$sha:scripts/checks/systemd/$b" > "$stage/units/$b" && [ -s "$stage/units/$b" ] \
    || { echo "install.sh: $b missing at $sha; nothing installed" >&2; exit 4; }
done
for f in "$stage"/lib/*.sh; do bash -n "$f" || { echo "install.sh: $(basename "$f") does not parse; nothing installed" >&2; exit 4; }; done
# quiesce: stop the timers and wait for a running check to finish, so no check runs while its files
# are half replaced (a check started mid-publish could load a new lib.sh with an old script)
services=(); for n in "${checks[@]}"; do services+=("teamclaude-check-$n.service"); done
# remember which timers run now (an unreadable state refuses before anything is stopped)
for t in "${timers[@]}"; do
  st=$($SYSTEMCTL --user is-active "$t" 2>/dev/null) || true
  case $st in
    active|activating|reloading) was_running+=("$t") ;;
    inactive|failed|unknown) ;;
    *) echo "install.sh: cannot read the state of $t (${st:-no answer}); nothing installed" >&2; exit 6 ;;
  esac
done
quiesced=1
$SYSTEMCTL --user stop "${timers[@]}" 2>/dev/null || true
# a stop that failed leaves a timer armed: refuse unless every timer reads inactive (or is not
# installed yet, which also reads inactive)
# only a recognized answer counts: an empty one (the user manager unreachable) is not "stopped"
for t in "${timers[@]}"; do
  st=$($SYSTEMCTL --user is-active "$t" 2>/dev/null) || true   # 3 = inactive, 4 = no such unit
  case $st in
    inactive|failed|unknown) ;;
    active|activating|reloading) echo "install.sh: $t did not stop; nothing installed" >&2; exit 6 ;;
    *) echo "install.sh: cannot read the state of $t (${st:-no answer}); nothing installed" >&2; exit 6 ;;
  esac
done
for _ in $(seq 1 60); do
  busy=0
  for svc in "${services[@]}"; do
    st=$($SYSTEMCTL --user is-active "$svc" 2>/dev/null) || true
    case $st in
      inactive|failed|unknown) ;;
      active|activating|deactivating|reloading) busy=1 ;;
      *) echo "install.sh: cannot read the state of $svc (${st:-no answer}); nothing installed" >&2; exit 6 ;;
    esac
  done
  [ "$busy" = 0 ] && break; sleep "${CHECK_INSTALL_WAIT_STEP:-5}"
done
[ "$busy" = 0 ] || { echo "install.sh: a check is still running after 5 min; nothing installed" >&2; exit 6; }
# publish: the complete, checked payload only. Preflight the destinations, keep a copy of what is
# there, and put it all back if any move fails, so scripts and units never mix two commits.
[ -w "$lib" ] && [ -w "$units" ] || { echo "install.sh: $lib or $units is not writable; nothing installed" >&2; exit 5; }
chmod 755 "$stage"/lib/*; chmod 644 "$stage"/units/*
mkdir "$stage/old"
pairs=()
for f in "$stage"/lib/*; do pairs+=("$f|$lib/$(basename "$f")"); done
for f in "$stage"/units/*; do pairs+=("$f|$units/$(basename "$f")"); done
for p in "${pairs[@]}"; do
  dst=${p#*|}
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    [ -f "$dst" ] && [ ! -L "$dst" ] || { echo "install.sh: $dst exists and is not a regular file; nothing installed" >&2; exit 5; }
    cp -p "$dst" "$stage/old/$(printf '%s' "$dst" | tr / %)"
  fi
done
done_=()
for p in "${pairs[@]}"; do
  src=${p%%|*} dst=${p#*|}
  # CHECK_INSTALL_FAIL_AT=<file name>: tests only, makes that one move fail to prove the restore
  if [ "${CHECK_INSTALL_FAIL_AT:-}" = "$(basename "$dst")" ] || ! mv -fT "$src" "$dst"; then
    for d in "${done_[@]}"; do
      o="$stage/old/$(printf '%s' "$d" | tr / %)"
      if [ -e "$o" ]; then cp -p "$o" "$d"; else rm -f -- "$d"; fi
    done
    echo "install.sh: publishing $dst failed; the previous install is restored" >&2; exit 5
  fi
  done_+=("$dst")
done
$SYSTEMCTL --user daemon-reload
$SYSTEMCTL --user enable --now "${timers[@]}"
finished=1
echo "installed $(git rev-parse --short "$sha"): ${timers[*]}"
