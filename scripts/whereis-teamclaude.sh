#!/usr/bin/env bash
# Locate the running TeamClaude service: which unit/process, which binary, and
# which config file it actually reads. Prints account names only — never tokens.
# Usage: bash scripts/whereis-teamclaude.sh   (paste the output back)

hr() { printf '\n=== %s ===\n' "$*"; }

hr "host / user"
echo "$(hostname) / $(id -un) uid=$(id -u)  HOME=$HOME  XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-<unset>}"

hr "teamclaude/teamrouter on PATH"
for b in teamclaude teamrouter; do
  p=$(command -v "$b") && echo "$b -> $p -> $(readlink -f "$p")" || echo "$b: not on PATH"
done
node -v 2>/dev/null || echo "node: not on PATH"

hr "processes"
pids=$(pgrep -f 'teamclaude|teamrouter' | grep -vx "$$" || true)
for pid in $pids; do
  [ -r "/proc/$pid/cmdline" ] || continue
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  case "$cmd" in *whereis-teamclaude*|*pgrep*) continue;; esac
  echo "--- pid $pid (user $(stat -c %U /proc/$pid))"
  # Arguments and env values can carry a credential in a URL (http://user:pass@…):
  # redact any userinfo, and print only the first three arguments.
  echo "cmd:  $(printf '%s' "$cmd" | cut -d' ' -f1-3 | sed -E 's#//[^/@ ]+@#//<redacted>@#g')"
  echo "cwd:  $(readlink /proc/$pid/cwd 2>/dev/null)"
  echo "unit: $(grep -o '[^/]*\.service' /proc/$pid/cgroup 2>/dev/null | tail -1)"
  echo "env:"
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null \
    | grep -E '^(TEAMCLAUDE_|TEAMROUTER_|HOME=|XDG_CONFIG_HOME=|USER=)' \
    | grep -viE 'KEY|TOKEN|SECRET|PASS|AUTH|PROXY' | sed -E 's#//[^/@ ]+@#//<redacted>@#g; s/^/  /'
done
[ -z "$pids" ] && echo "no teamclaude/teamrouter process found"

hr "systemd units mentioning teamclaude/teamrouter"
for scope in --user --system; do
  systemctl $scope list-units --all --type=service --no-legend 2>/dev/null \
    | grep -iE 'teamclaude|teamrouter' | sed "s/^/[$scope] /"
done
for f in ~/.config/systemd/user/*.service /etc/systemd/system/*.service /etc/systemd/user/*.service; do
  [ -f "$f" ] && grep -qiE 'teamclaude|teamrouter' "$f" && {
    echo "--- $f"
    grep -E '^(ExecStart|Environment|WorkingDirectory|User)=' "$f" | grep -viE 'KEY|TOKEN|SECRET|PASS|AUTH|PROXY' | sed -E 's#//[^/@ ]+@#//<redacted>@#g'
  }
done
# Units started by a process manager other than systemd
command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | grep -o '"name":"[^"]*"' | grep -iE 'team' && echo "(pm2 above)"
docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -iE 'team' && echo "(docker above)"

hr "listening ports"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E 'node|teamclaude|teamrouter'

hr "config files"
cands=$( {
  ls ~/.config/teamclaude*.json ~/.config/teamrouter*.json 2>/dev/null
  for pid in $pids; do
    [ -r "/proc/$pid/environ" ] && tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^TEAM\(CLAUDE\|ROUTER\)_CONFIG=//p'
  done
} | sort -u)
for f in $cands; do
  [ -f "$f" ] || { echo "--- $f (missing)"; continue; }
  echo "--- $f  ($(stat -c '%s bytes, modified %y' "$f"))"
  node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const a = c.accounts || [];
    console.log(`  ${a.length} accounts; top-level keys: ${Object.keys(c).join(", ")}`);
    for (const x of a) console.log(`  - ${x.name}  type=${x.type}${x.provider ? " provider=" + x.provider : ""}${x.email ? " email=" + x.email : ""}${x.disabled || x.enabled === false ? " DISABLED" : ""}  fields=${Object.keys(x).filter(k => !/token|key|secret/i.test(k)).join(",")}`);
  ' "$f" 2>/dev/null | sed 's/^/ /' || echo "  (config unreadable or not JSON)"
done

hr "control endpoint"
for port in $( (ss -ltnp 2>/dev/null) | grep node | grep -oE ':[0-9]+ ' | tr -d ': ' | sort -u); do
  printf 'port %s: ' "$port"
  curl -s -m 2 -o /dev/null -w '/ui %{http_code}  ' "http://127.0.0.1:$port/ui"
  curl -s -m 2 -o /dev/null -w '/teamclaude/add-account %{http_code}\n' "http://127.0.0.1:$port/teamclaude/add-account"
done
