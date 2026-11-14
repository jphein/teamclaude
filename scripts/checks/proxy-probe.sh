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
#   envsh-bypass   env.sh points at the pool but NO_PROXY/no_proxy holds * or an entry matching a
#                  host claude calls (api.anthropic.com, claude.ai, …), so those calls skip it
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
  # unquoted values may not hold anything bash would expand: braces ({a,b} is two words), ~, globs
  local plain="[^${B}'\"\$\`;&|()<>{}~*?[\\\\]*" sq="'[^']*'" dq="\"[^\"\$\`\\\\]*\""
  # a comment only after a blank: a # touching a value is part of the shell word (…'x'#$(cmd) runs)
  local re_export="^[${B}]*export[${B}]+([A-Za-z_][A-Za-z0-9_]*)=(${plain}|${sq}|${dq})([${B}]+#.*)?[${B}]*\$"
  local re_unset="^[${B}]*unset(([${B}]+[A-Za-z_][A-Za-z0-9_]*)+)([${B}]+#.*)?[${B}]*\$"
  local re_skip="^[${B}]*(#.*)?\$"
  local re_pool="^(http://127\\.0\\.0\\.1:3456/?|https://[A-Za-z0-9._~%:+=-]+@10\\.0\\.6\\.145:3443/?)\$"
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
  # NO_PROXY host rules, against the hosts claude calls: an entry matches a host it equals or a parent
  # domain of it, even without a leading "." (curl's rule; Node's proxy-from-env wants the dot, and
  # claude here is a Bun binary, so the broader reading is kept: a false warn, never a false ok); a leading "." or "*." and a ":port" are dropped; "*" matches everything. The list is
  # split into an array (no word splitting, no filename expansion of a *), entries lowercased.
  local hosts=(api.anthropic.com console.anthropic.com statsig.anthropic.com mcp-proxy.anthropic.com claude.ai) host
  # entries are separated by commas, spaces or tabs (as Node splits NO_PROXY), never joined
  local all="$np,$npl" port
  all=${all//[ $'\t']/,}
  # any other byte outside printable ASCII (\v, \f, NBSP, U+2003 …) is a separator to some clients
  # and part of a name to others: the list cannot be read safely
  [[ "$all" =~ [^\ -~] ]] && { echo envsh-unverifiable; return; }
  IFS=, read -r -a list <<<"$all"
  for e in "${list[@]}"; do
    e=${e,,}
    [ -n "$e" ] || continue
    # the port first: "*:443" is a wildcard once its port is read
    port=
    if [[ "$e" == *:* ]]; then port=${e##*:}; e=${e%:*}; fi
    # claude calls these hosts on 443 only: a numeric port other than 443 (0443 is 443) cannot match;
    # an empty or non-numeric port is read as covering the host (a warn, never a false ok)
    if [[ "$port" =~ ^[0-9]+$ ]] && (( 10#$port != 443 )); then continue; fi
    [ "$e" = '*' ] && { echo envsh-bypass; return; }
    [ -n "$e" ] || continue
    for host in "${hosts[@]}"; do
      case $e in
        '*'*) [[ "$host" == *"${e#\*}" ]] && { echo envsh-bypass; return; } ;;   # leading * : any suffix
        .*)   [[ "$host" == *"$e" || "$host" == "${e#.}" ]] && { echo envsh-bypass; return; } ;;
        *)    [[ "$host" == "$e" || "$host" == *".$e" ]] && { echo envsh-bypass; return; } ;;
      esac
    done
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
  have=$(sha256sum < "$w" 2>/dev/null | cut -d' ' -f1)   # stdin: a path never escapes the digest
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
# What the running claude CLIs actually do: through the pool every HTTPS call is a CONNECT to the
# forwarder (127.0.0.1:3456) or the VM on the LAN, so a claude process holding an established
# connection to a PUBLIC address on port 443 is going around the pool, whatever PATH, wrapper or
# settings launched it. (/proc/<pid>/environ is not enough: ~/.claude/settings.json sets the proxy
# inside claude after start.) Processes are found by executable path, never by name.
private() { # host -> 0 when loopback, LAN or link-local
  local h=${1#[}; h=${h%]}; h=${h#::ffff:}
  case $h in
    127.*|10.*|192.168.*|169.254.*|::1|fe[89ab]?:*|fc*|fd*|localhost) return 0 ;;   # fe80::/10 is fe8x-febx
    172.*) local o=${h#172.}; o=${o%%.*}; [[ "$o" =~ ^[0-9]+$ ]] && (( o >= 16 && o <= 31 )) && return 0 ;;
  esac
  return 1
}
procroot=${CHECK_PROC:-/proc}
declare -A cl=()
for d in "$procroot"/[0-9]*; do
  e=$(readlink "$d/exe" 2>/dev/null) || continue
  case $e in */claude/versions/*) cl[${d##*/}]=1 ;; esac
done
declare -A around=()
# the listing itself must succeed: a failed ss (missing, no permission) is "cannot tell", never 0
if conns=$(${CHECK_SS:-ss} -tnpH state established 2>/dev/null); then direct_ok=1; else direct_ok=0; conns=; fi
while read -r peer procs; do
  port=${peer##*:}; host=${peer%:*}
  [ "$port" = 443 ] || continue
  private "$host" && continue
  for pid in $(grep -oE 'pid=[0-9]+' <<<"$procs" | cut -d= -f2); do
    [ -n "${cl[$pid]:-}" ] && around[$pid]=1
  done
done < <(awk '{print $4, $5}' <<<"$conns")
if [ "$direct_ok" = 1 ]; then direct=${#around[@]}; else direct=unknown; fi
echo "proxy=$code wrapper=$state claude=${#cl[@]} direct=$direct"
