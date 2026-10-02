#!/bin/bash
# Desktop launcher: open the TeamClaude dashboard.
# Remote mode (2026-10-02): when ~/.config/claude-code/teamclaude-remote.env exists
# (TC_REMOTE=host:port, TC_KEY=<proxy clientKey>), the proxy runs on that host as a
# LAN service (ufw admits only this machine); open its full dashboard via SSH.
# Otherwise: start the local user service and open the loopback dashboard.
remote=~/.config/claude-code/teamclaude-remote.env
if [ -f "$remote" ]; then
  . "$remote"
  # The full dashboard (/ui: quota slider, logs, re-auth) answers only loopback
  # callers, so reach it through an on-demand SSH forward to familiar's loopback:
  # encrypted, no key handling, and only for this admin page. Agents keep using
  # the LAN service directly.
  host=${TC_SSH_HOST:-familiar}; lport=${TC_UI_PORT:-3457}
  if ! curl -sf -m2 --noproxy '*' "http://127.0.0.1:$lport/ui" >/dev/null 2>&1; then
    ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
        -L "127.0.0.1:$lport:127.0.0.1:${TC_REMOTE##*:}" "$host" 2>/dev/null
    for i in $(seq 1 20); do
      curl -sf -m2 --noproxy '*' "http://127.0.0.1:$lport/ui" >/dev/null 2>&1 && break
      sleep 0.3
    done
  fi
  if ! curl -sf -m2 --noproxy '*' "http://127.0.0.1:$lport/ui" >/dev/null 2>&1; then
    notify-send -i dialog-error 'TeamClaude' "Could not reach the dashboard on $host"
    exit 1
  fi
  xdg-open "http://127.0.0.1:$lport/ui" >/dev/null 2>&1
  exit 0
fi
systemctl --user start teamclaude 2>/dev/null
for i in $(seq 1 30); do
  curl -sf -m2 --noproxy '*' http://127.0.0.1:3456/ui >/dev/null 2>&1 && break
  sleep 0.4
done
xdg-open http://localhost:3456/ui >/dev/null 2>&1
