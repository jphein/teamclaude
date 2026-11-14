#!/usr/bin/env bash
# Runs ON one client host (piped over ssh by proxy-wrapper.sh, or locally). Prints one line:
#   proxy=<HTTP code of GET 127.0.0.1:<port>/teamclaude/quota, 000 = no answer> wrapper=<state>
# wrapper states:
#   refuses       ~/.cargo/bin/claude exits 69 when its proxy port is closed (fails closed)
#   runs-rc<N>    ~/.cargo/bin/claude did NOT refuse (an old wrapper that falls back to the own login)
#   envsh-pool    no cargo wrapper; the cc switcher's env.sh pins HTTPS_PROXY to the pool (katana)
#   envsh-off     no cargo wrapper; env.sh does not point at the pool (a run would use the own login)
#   none          neither exists
# The refusal test points the wrapper at port 1 (closed) and at /bin/true as the real claude, so
# nothing real starts; an old wrapper ignores both and runs `claude --version` on the open proxy.
port=${CHECK_PROXY_PORT:-3456}
code=$(env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY \
  curl -q -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 10 "http://127.0.0.1:$port/teamclaude/quota" 2>/dev/null)
[ -n "$code" ] || code=000
w="$HOME/.cargo/bin/claude"
if [ -x "$w" ]; then
  TEAMCLAUDE_PROXY_PORT=1 TEAMCLAUDE_REAL_CLAUDE=/bin/true TEAMCLAUDE_ALLOW_DIRECT= TEAMCLAUDE_BYPASS= \
    timeout 30 "$w" --version >/dev/null 2>&1
  rc=$?
  [ "$rc" = 69 ] && state=refuses || state="runs-rc$rc"
elif [ -f "$HOME/.config/claude-code/env.sh" ]; then
  if grep -qE '^[[:space:]]*export[[:space:]]+HTTPS_PROXY=(http://127\.0\.0\.1:3456|https://[^[:space:]]*@10\.0\.6\.145:3443)' "$HOME/.config/claude-code/env.sh"; then
    state=envsh-pool
  else
    state=envsh-off
  fi
else
  state=none
fi
echo "proxy=$code wrapper=$state"
