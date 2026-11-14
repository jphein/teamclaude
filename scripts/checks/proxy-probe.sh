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
#   envsh-bypass   env.sh points at the pool but NO_PROXY/no_proxy holds * or an anthropic/claude
#                  entry, so claude's API calls skip it
#   envsh-unverifiable  env.sh has a line that is not a comment, `unset NAMES` or a literal
#                  `export NAME=value`, or it leaves one of HTTPS_PROXY, https_proxy, NO_PROXY,
#                  no_proxy to the caller's environment, so its effect cannot be read from the file
#   none           neither exists
# The HTTPS_PROXY value carries a client key: it is compared here, never printed.
envsh_state() { # read env.sh line by line, as the shell would apply it, without executing anything
  local LC_ALL=C    # byte semantics: no locale-dependent class may match more than bash splits on
  local line name v hp= hpl= np= npl= e list
  local -A set=()   # which of the four the file itself settles (exported or unset)
  local B=$' \t'    # bash splits words on space and tab only (\v, \f, U+2003 stay in a value)
  local plain="[^${B}'\"\$\`;&|()<>\\\\]*" sq="'[^']*'" dq="\"[^\"\$\`\\\\]*\""
  # a comment only after a blank: a # touching a value is part of the shell word (…'x'#$(cmd) runs)
  local re_export="^[${B}]*export[${B}]+([A-Za-z_][A-Za-z0-9_]*)=(${plain}|${sq}|${dq})([${B}]+#.*)?[${B}]*\$"
  local re_unset="^[${B}]*unset(([${B}]+[A-Za-z_][A-Za-z0-9_]*)+)([${B}]+#.*)?[${B}]*\$"
  local re_skip="^[${B}]*(#.*)?\$"
  local re_pool="^(http://127\\.0\\.0\\.1:3456|https://[A-Za-z0-9._~%:+=-]+@10\\.0\\.6\\.145:3443/?)\$"
  while IFS= read -r line || [ -n "$line" ]; do
    # a carriage return becomes part of the value in bash: never normalized, never read past
    [[ "$line" == *$'\r'* ]] && { echo envsh-unverifiable; return; }
    [[ "$line" =~ $re_skip ]] && continue
    if [[ "$line" =~ $re_unset ]]; then
      for name in ${BASH_REMATCH[1]}; do
        case $name in HTTPS_PROXY) hp= ;; https_proxy) hpl= ;; NO_PROXY) np= ;; no_proxy) npl= ;; esac
        set[$name]=1
      done
      continue
    fi
    if [[ "$line" =~ $re_export ]]; then
      name=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}
      case $v in \'*\'|\"*\") v=${v:1:${#v}-2} ;; esac
      case $name in HTTPS_PROXY) hp=$v ;; https_proxy) hpl=$v ;; NO_PROXY) np=$v ;; no_proxy) npl=$v ;; esac
      set[$name]=1
      continue
    fi
    echo envsh-unverifiable; return
  done < "$1"
  # the file alone must decide: a variable it neither exports nor unsets comes from whoever runs claude
  for name in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do
    [ -n "${set[$name]:-}" ] || { echo envsh-unverifiable; return; }
  done
  # Node reads https_proxy before HTTPS_PROXY: each set one must be the pool, and one must be set
  { [ -z "$hp" ] || [[ "$hp" =~ $re_pool ]]; } && { [ -z "$hpl" ] || [[ "$hpl" =~ $re_pool ]]; } && [ -n "$hp$hpl" ] \
    || { echo envsh-off; return; }
  # a no-proxy entry of * or naming anthropic/claude sends claude's API calls around the pool
  # split into an array (no word splitting, no filename expansion of a *), compare lowercased
  IFS=, read -r -a list <<<"$np,$npl"
  for e in "${list[@]}"; do
    e=${e,,}; e=${e//[ $'\t']/}
    case $e in '*'|*anthropic*|*claude*) echo envsh-bypass; return ;; esac
  done
  echo envsh-pool
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
