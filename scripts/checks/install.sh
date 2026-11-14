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
timers=()
for u in $(git ls-tree --name-only "$sha" scripts/checks/systemd/); do
  b=$(basename "$u"); git show "$sha:$u" > "$stage/units/$b"
  case $b in *.timer) timers+=("$b") ;; esac
done
[ ${#timers[@]} -ge 1 ] || { echo "install.sh: no timers at $sha; nothing installed" >&2; exit 4; }
for f in "$stage"/lib/*.sh; do bash -n "$f" || { echo "install.sh: $(basename "$f") does not parse; nothing installed" >&2; exit 4; }; done
# publish: the complete, checked payload only
chmod 755 "$stage"/lib/*; chmod 644 "$stage"/units/*
for f in "$stage"/lib/*; do mv -f "$f" "$lib/$(basename "$f")"; done
for f in "$stage"/units/*; do mv -f "$f" "$units/$(basename "$f")"; done
$SYSTEMCTL --user daemon-reload
$SYSTEMCTL --user enable --now "${timers[@]}"
echo "installed $(git rev-parse --short "$sha"): ${timers[*]}"
