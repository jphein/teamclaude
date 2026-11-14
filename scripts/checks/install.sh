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
stage=$(mktemp -d "$lib/.stage.XXXXXX"); trap 'rm -rf -- "${stage:?}"' EXIT
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
echo "installed $(git rev-parse --short "$sha"): ${timers[*]}"
