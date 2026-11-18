#!/usr/bin/env bash
# Run on ONE client host (locally, or as `ssh host bash -s < this`) by proxy-creds.sh. Prints only
# paths, counts and process names, never a value:
#   FILE <path relative to $HOME>     a config file that sets a proxy URL carrying userinfo (a key)
#   REMOTE <path>                     cc's teamclaude-remote.env exists (`cc teams` would write its key into env.sh)
#   PROC <count> <comm,comm,…>        processes of this user whose environment holds such a proxy URL
#   END                               the probe finished (no END = the host could not be read)
# Inputs (tests): HOME, CHECK_PROC_DIR (default /proc).
set -u
shopt -s nullglob
# a proxy variable set to scheme://<userinfo>@… in shell, JSON or systemd syntax
re='(HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy)["'"'"']?[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z][A-Za-z0-9+.-]*://[^@/[:space:]"'"'"']+@'
for f in "$HOME/.config/claude-code/env.sh" "$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json" \
         "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.config/environment.d/"*.conf \
         "$HOME/.config/systemd/user/"*.service "$HOME/.config/systemd/user/"*.d/*.conf; do
  [ -f "$f" ] && grep -qE "$re" "$f" 2>/dev/null && printf 'FILE %s\n' "${f#"$HOME"/}"
done
[ -f "$HOME/.config/claude-code/teamclaude-remote.env" ] && printf 'REMOTE %s\n' ".config/claude-code/teamclaude-remote.env"
proc=${CHECK_PROC_DIR:-/proc}
n=0; comms=()
for p in "$proc"/[0-9]*; do
  [ -O "$p/environ" ] || [ -n "${CHECK_PROC_DIR:-}" ] || continue
  if tr '\0' '\n' < "$p/environ" 2>/dev/null | grep -qE "^(HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy)=[A-Za-z][A-Za-z0-9+.-]*://[^@/]+@"; then
    n=$((n + 1))
    c=$(tr -d '\n' < "$p/comm" 2>/dev/null | tr -c 'A-Za-z0-9._-' '?' | head -c 20)
    comms+=("${c:-?}")
  fi
done
if [ "$n" -gt 0 ]; then printf 'PROC %s %s\n' "$n" "$(printf '%s\n' "${comms[@]}" | sort | uniq -c | awk '{printf "%s%s×%s", (NR>1?",":""), $2, $1}')"; fi
echo END
