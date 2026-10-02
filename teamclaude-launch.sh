#!/bin/bash
# Desktop launcher: open the TeamClaude dashboard.
# Remote mode (2026-10-02): when ~/.config/claude-code/teamclaude-remote.env exists
# (TC_REMOTE=host:port, TC_KEY=<proxy clientKey>), the proxy runs on that host as a
# LAN service (ufw admits only this machine). Open its key-gated dashboard and put
# the key on the clipboard for the dashboard's one-time key box.
# Otherwise: start the local user service and open the loopback dashboard.
remote=~/.config/claude-code/teamclaude-remote.env
if [ -f "$remote" ]; then
  . "$remote"
  # Fail closed: hand out the key only after an authenticated status check passes.
  if ! curl -sf -m4 --noproxy '*' -H "x-api-key: $TC_KEY" "http://$TC_REMOTE/teamclaude/status" >/dev/null 2>&1; then
    notify-send -i dialog-error 'TeamClaude' "Proxy at $TC_REMOTE is not answering; dashboard not opened"
    exit 1
  fi
  printf '%s' "$TC_KEY" | wl-copy 2>/dev/null
  # Don't leave the key on the clipboard: clear it after 45 s unless something else was copied.
  ( sleep 45; [ "$(wl-paste -n 2>/dev/null)" = "$TC_KEY" ] && wl-copy --clear ) >/dev/null 2>&1 &
  disown
  notify-send -i dialog-information 'TeamClaude' 'Proxy key is on the clipboard for 45 s if the dashboard asks for it'
  xdg-open "http://$TC_REMOTE/teamclaude/dashboard" >/dev/null 2>&1
  exit 0
fi
systemctl --user start teamclaude 2>/dev/null
for i in $(seq 1 30); do
  curl -sf -m2 --noproxy '*' http://127.0.0.1:3456/ui >/dev/null 2>&1 && break
  sleep 0.4
done
xdg-open http://localhost:3456/ui >/dev/null 2>&1
