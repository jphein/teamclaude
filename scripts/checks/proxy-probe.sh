#!/usr/bin/env bash
# Runs ON one client host (piped over ssh by proxy-wrapper.sh, or locally). Prints one line:
#   proxy=<HTTP code of GET 127.0.0.1:<port>/teamclaude/quota, 000 = no answer> wrapper=<state>
# Nothing is executed to judge the wrapper: running an unknown ~/.cargo/bin/claude could start a
# real session or change state. Instead:
#   refuses        ~/.cargo/bin/claude is byte-identical to the reviewed wrapper ($1 = its sha256),
#                  which exits 69 when its proxy is down (tested in the repo, test/claude-wrapper)
#   wrapper-<sha8> a different ~/.cargo/bin/claude (e.g. the pre-#66 one that falls back to the own
#                  login): not run, reported for a look
#   envsh-pool     no cargo wrapper; the cc switcher's env.sh, sourced in a subshell, leaves
#                  HTTPS_PROXY exactly at the pool (http://127.0.0.1:3456 or https://…@10.0.6.145:3443)
#   envsh-off      no cargo wrapper; env.sh leaves HTTPS_PROXY anywhere else (a run uses the own login)
#   none           neither exists
# The HTTPS_PROXY value carries a client key: it is compared inside the subshell, never printed.
want=${1:-}
port=${CHECK_PROXY_PORT:-3456}
code=$(env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY \
  curl -q -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 10 "http://127.0.0.1:$port/teamclaude/quota" 2>/dev/null)
[[ "$code" =~ ^[0-9]{3}$ ]] || code=000
w="$HOME/.cargo/bin/claude"
if [ -e "$w" ]; then
  have=$(sha256sum "$w" 2>/dev/null | cut -d' ' -f1)
  if [ -n "$want" ] && [ "$have" = "$want" ]; then state=refuses; else state="wrapper-${have:0:8}"; fi
  [ -n "$have" ] || state=wrapper-unreadable
elif [ -f "$HOME/.config/claude-code/env.sh" ]; then
  # the effective value after the whole file ran (a later unset or export wins), in a subshell
  if env -i HOME="$HOME" PATH=/usr/bin:/bin bash -c '. "$HOME/.config/claude-code/env.sh" >/dev/null 2>&1
       [[ "${HTTPS_PROXY:-}" == "http://127.0.0.1:3456" || "${HTTPS_PROXY:-}" =~ ^https://[^@/[:space:]]+@10\.0\.6\.145:3443/?$ ]]'; then
    state=envsh-pool
  else
    state=envsh-off
  fi
else
  state=none
fi
echo "proxy=$code wrapper=$state"
