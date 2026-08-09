#!/bin/bash
# Desktop launcher: start the teamclaude user service, wait for it, open the dashboard.
systemctl --user start teamclaude 2>/dev/null
for i in $(seq 1 30); do
  curl -sf -m2 --noproxy '*' http://127.0.0.1:3456/ui >/dev/null 2>&1 && break
  sleep 0.4
done
xdg-open http://localhost:3456/ui >/dev/null 2>&1
