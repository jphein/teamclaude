#!/usr/bin/env bash
# Install the teamclaude CHECK timers on familiar from a MERGED commit (never from a working tree):
#   scripts/checks/install.sh <commit>
# Scripts go to ~/.local/libexec/teamclaude-checks/, units to ~/.config/systemd/user/; each file is
# written beside its target and moved into place. Timers are enabled and started. Rollback:
#   systemctl --user disable --now teamclaude-check-{pool-quota,proxy-wrapper,forge-keys}.timer
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: scripts/checks/install.sh <commit>" >&2; exit 22; }
cd "$(dirname "$0")/../.."
sha=$(git rev-parse --verify "$1^{commit}")
git merge-base --is-ancestor "$sha" origin/master || { echo "install.sh: $1 is not on origin/master; merge first" >&2; exit 3; }
lib="$HOME/.local/libexec/teamclaude-checks"; units="$HOME/.config/systemd/user"
mkdir -p "$lib" "$units"
for f in lib.sh pool-quota.sh proxy-probe.sh proxy-wrapper.sh forge-keys.sh summary.sh; do
  git show "$sha:scripts/checks/$f" > "$lib/.$f.new"; chmod 755 "$lib/.$f.new"; mv -f "$lib/.$f.new" "$lib/$f"
done
timers=()
for u in $(git ls-tree --name-only "$sha" scripts/checks/systemd/); do
  b=$(basename "$u"); git show "$sha:$u" > "$units/.$b.new"; chmod 644 "$units/.$b.new"; mv -f "$units/.$b.new" "$units/$b"
  case $b in *.timer) timers+=("$b") ;; esac
done
systemctl --user daemon-reload
systemctl --user enable --now "${timers[@]}"
echo "installed $(git rev-parse --short "$sha"): ${timers[*]}"
