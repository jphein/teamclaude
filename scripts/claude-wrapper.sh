#!/bin/sh
# claude via teamclaude: the `claude` on PATH for familiar and wakizashi,
# installed as ~/.cargo/bin/claude (first on both the login PATH and the lanes'
# PATH exports; the Claude installer rewrites ~/.local/bin/claude on every
# update, so the wrapper cannot live there). katana does not use this file: its
# ~/.local/bin/claude sources the cc switcher's env.sh instead.
#
# The host's forwarder listens on 127.0.0.1:3456 and carries the session into
# the teamclaude pool. When it does not answer, the wrapper REFUSES to start
# (exit 69) instead of running on this host's own login: that login is a seat
# outside the pool, and a run on it is invisible to the pool's quota and to the
# "usage limit" rule (2026-11-14, Sen's finding from the nightly-sweep build;
# the old fallback printed one stderr line that unattended runs discard).
#
#   TEAMCLAUDE_ALLOW_DIRECT=1  proxy down: run on this host's own login anyway
#   TEAMCLAUDE_BYPASS=1        skip the proxy even when it is up
# Both say so on stderr. Test knobs: TEAMCLAUDE_PROXY_PORT (default 3456),
# TEAMCLAUDE_REAL_CLAUDE (default: where ~/.local/bin/claude points).
# Source of truth: jphein/teamclaude scripts/claude-wrapper.sh.
PORT=${TEAMCLAUDE_PROXY_PORT:-3456}
REAL=${TEAMCLAUDE_REAL_CLAUDE:-$(readlink -f "$HOME/.local/bin/claude")}
HOST=$(hostname -s 2>/dev/null || echo this-host)
case $PORT in
  ''|*[!0-9]*) echo "[claude] TEAMCLAUDE_PROXY_PORT must be a port number" >&2; exit 64 ;;
esac
# The direct paths drop any inherited proxy settings, so "outside the pool"
# is what actually happens.
direct() { unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy; }

if [ -n "$TEAMCLAUDE_BYPASS" ]; then
  direct
  echo "[claude] TEAMCLAUDE_BYPASS set: running on $HOST's own login, outside the teamclaude pool" >&2
elif timeout 2 bash -c ': </dev/tcp/127.0.0.1/"$1"' _ "$PORT" 2>/dev/null; then
  P=http://127.0.0.1:$PORT
  export HTTPS_PROXY=$P HTTP_PROXY=$P https_proxy=$P http_proxy=$P
  export NO_PROXY='localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.jphe.in,.realm.watch,.local,familiar,disks,ubox0,nodered,game,katana,gatekeeper' no_proxy='localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.jphe.in,.realm.watch,.local,familiar,disks,ubox0,nodered,game,katana,gatekeeper'
  export NODE_EXTRA_CA_CERTS="$HOME/.config/teamclaude-ca.pem"
  unset ANTHROPIC_BASE_URL
elif [ "$TEAMCLAUDE_ALLOW_DIRECT" = 1 ]; then
  direct
  echo "[claude] teamclaude proxy :$PORT down; TEAMCLAUDE_ALLOW_DIRECT=1, so running on $HOST's own login, outside the pool" >&2
else
  echo "[claude] teamclaude proxy :$PORT down; set TEAMCLAUDE_ALLOW_DIRECT=1 to run on the seat" >&2
  exit 69
fi
exec "$REAL" "$@"
