#!/usr/bin/env bash
# Runs ON one client host (piped over ssh by proxy-wrapper.sh, or locally). Prints one line:
#   proxy=<HTTP code of GET 127.0.0.1:<port>/teamclaude/quota, 000 = no answer> wrapper=<state>
# Nothing is executed to judge the wrapper: running an unknown ~/.cargo/bin/claude could start a
# real session or change state. Instead:
#   refuses        ~/.cargo/bin/claude is byte-identical to the reviewed wrapper ($1 = its sha256),
#                  which exits 69 when its proxy is down (tested in the repo, test/claude-wrapper)
#   wrapper-notexec ~/.cargo/bin/claude exists but is not executable (PATH falls through to claude)
#   wrapper-<sha8> a different ~/.cargo/bin/claude (e.g. the pre-#66 one that falls back to the own
#                  login): not run, reported for a look
#   envsh-pool     no cargo wrapper; the cc switcher's env.sh, READ (never run), leaves HTTPS_PROXY
#                  exactly at the pool (http://127.0.0.1:3456 or https://…@10.0.6.145:3443)
#   envsh-off      no cargo wrapper; env.sh leaves HTTPS_PROXY anywhere else (a run uses the own login)
#   envsh-unverifiable  env.sh has a line that is not a comment, `unset NAMES` or a literal
#                  `export NAME=value`, so its effect cannot be read without running it
#   none           neither exists
# The HTTPS_PROXY value carries a client key: it is compared here, never printed.
envsh_state() { # read env.sh line by line, as the shell would apply it, without executing anything
  local line val= name v
  local plain='[^[:space:]'"'"'"$`;&|()<>\\]*' sq="'[^']*'" dq='"[^"$`\\]*"'
  local re_export="^[[:space:]]*export[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)=(${plain}|${sq}|${dq})[[:space:]]*(#.*)?$"
  local re_unset='^[[:space:]]*unset(([[:space:]]+[A-Za-z_][A-Za-z0-9_]*)+)[[:space:]]*(#.*)?$'
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    if [[ "$line" =~ $re_unset ]]; then
      for name in ${BASH_REMATCH[1]}; do [ "$name" = HTTPS_PROXY ] && val=; done
      continue
    fi
    if [[ "$line" =~ $re_export ]]; then
      if [ "${BASH_REMATCH[1]}" = HTTPS_PROXY ]; then
        v=${BASH_REMATCH[2]}; v=${v#[\'\"]}; v=${v%[\'\"]}; val=$v
      fi
      continue
    fi
    echo envsh-unverifiable; return
  done < "$1"
  if [[ "$val" == "http://127.0.0.1:3456" || "$val" =~ ^https://[^@/[:space:]]+@10\.0\.6\.145:3443/?$ ]]; then echo envsh-pool; else echo envsh-off; fi
}
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
  # bash skips a wrapper it cannot execute and runs the next claude on PATH (the own login)
  [ -x "$w" ] || state=wrapper-notexec
elif [ -f "$HOME/.config/claude-code/env.sh" ]; then
  # the effective value after the whole file ran (a later unset or export wins), in a subshell
  state=$(envsh_state "$HOME/.config/claude-code/env.sh")
else
  state=none
fi
echo "proxy=$code wrapper=$state"
