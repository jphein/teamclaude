# MITM CA reissue with key identifiers — migration plan

**Owner:** teamclaude-a6 (DEFERRALS-2026-10-27). **Proposed window:** stage B Wed 2026-10-28 evening, cutover (stage C) **Fri 2026-10-30 07:00–07:30 PDT**, cleanup (stage D) ≥ Fri 2026-11-06. Filed as a spec because GitHub Issues are disabled on the fork.

## Why

Python ≥ 3.13 verifies in strict X.509 mode. The MITM chain the VM presents for `api.anthropic.com` (CA "TeamClaude Local CA", issued 2026-06-23, sha256 `EC:A0:16:64:…`; leaf from the same day) carries **no Subject or Authority Key Identifier**. So every Python client behind the proxy fails "Missing Authority Key Identifier" even with the CA trusted. Measured 2026-10-27 with Python 3.14.4 and `SSL_CERT_FILE` set to a system + teamclaude bundle. The first casualty is the security-guidance Stop review; familiar now runs with `ENABLE_STOP_REVIEW=0` until this lands. #19 added SKI/AKI only to newly issued certificates, and deliberately did not renew the MITM chain because every client trusts it.

## Facts the plan rests on (measured 2026-10-27)

- **The VM holds** `~/.config/teamclaude-ca.pem` (CA cert), `teamclaude-leaf.pem` and `teamclaude-leaf.key`. There is **no CA private key**: the chain is one multi-SAN leaf, so a reissue means a new chain (`generateCertChain`), not re-signing.
- **The CA name collides.** `createCA` defaults to the CN "TeamClaude Local CA", the same as the current CA. Trusting two same-named CAs side by side, where the old one has no SKI, is the 2026-10-08 failure: OpenSSL picked the wrong issuer, "certificate signature failure". **The new CA must have a per-generation name**, as #19 gave the listener CA (`TeamClaude Listener CA <12hex>`).
- **Clients trust the CA by file path, not by content:**

  | Host | Setting | File |
  |---|---|---|
  | familiar | `~/.claude/settings.json` NODE_EXTRA_CA_CERTS (this file syncs familiar ↔ katana) | `~/.config/teamclaude-ca.pem` |
  | katana | settings.json (same synced file) | `~/.config/teamclaude-ca.pem` |
  | katana | `~/.config/claude-code/env.sh` NODE_EXTRA_CA_CERTS (the `claude` wrapper sources it) | `~/.config/teamclaude-ca-bundle.pem` |
  | wakizashi | `~/.claude/settings.json` NODE_EXTRA_CA_CERTS | `~/.config/teamclaude-ca.pem` |
  | familiar (Python) | `SSL_CERT_FILE` (not set anywhere yet) | `~/.config/teamclaude-python-ca-bundle.pem` |
  | VM | the bundle it serves to listener clients | `~/.config/teamclaude-ca-bundle.pem` (MITM CA + listener CA) |

- **NODE_EXTRA_CA_CERTS is read once, at process start.** A running `claude` only trusts the new CA after it restarts.
- **The listener chain is separate** (`TeamClaude Listener CA c3fc5e07bb90`, which Caddy on ubox0 and katana trust). It is **not** touched.

## Stages

### A — code (PR, before Wed 10/28) — DONE 2026-10-27 (`teamclaude certs rotate-mitm`; clients' file = `teamclaude-mitm-trust.pem`)
1. The MITM CA gets a per-generation CN, `TeamClaude MITM CA <12hex>`, mirroring `LISTENER_CA_CN`.
2. A staged rotation: `teamclaude certs rotate-mitm --stage` (runs with the proxy up; `--commit`, `--rollback` and `--finish` need it stopped, so nothing reads the chain while it changes). It writes the new chain beside the live one (`teamclaude-ca.next.pem`, `teamclaude-leaf.next.{pem,key}`), refreshes `teamclaude-ca-bundle.pem` to hold the **old MITM CA + new MITM CA + listener CA**, and prints the new CA's fingerprint. `--commit` swaps the `.next` files in (keeping `.prev` copies) for the next start. `--rollback` restores `.prev`.
3. Tests:
   - the new chain carries SKI and AKI;
   - Python strict verification passes against a fixture;
   - **dual trust:** a Node client trusting old + new resolves each leaf to the right CA (positive control: the same-CN pair fails, reproducing 10-08);
   - the listener chain is untouched.
4. Gate: CI, tests, red perturbations, gitleaks, one independent review (Foundry xreview).

### B — dual trust everywhere (Wed 10/28 evening; no restart of the proxy)
1. On the VM: `rotate-mitm --stage`. Back up `~/.config/teamclaude-*` first (`tar`, 0600). Record the new fingerprint.
2. **Keep every path; change the contents.** On familiar, katana and wakizashi, `~/.config/teamclaude-ca.pem` becomes old MITM CA + new MITM CA. Katana's `teamclaude-ca-bundle.pem` becomes the VM's new bundle. familiar's Python bundle becomes system CAs + both MITM CAs. **No settings file changes**, so nothing synced moves.
3. Positive controls on each host:
   - `openssl verify -CAfile ~/.config/teamclaude-ca.pem` against the **current** live leaf (must still pass);
   - the same against the staged `.next` leaf (must pass);
   - a fresh `claude -p` through the proxy (must answer).

### Between B and C — lanes pick up the new trust
Every `claude` process must have started **after** stage B, or it will fail its MITM handshakes at cutover.
- Check: `ps -o pid,lstart,args -C claude` (and the versioned binary names) on each host. Any process older than stage B gets restarted, through its own lead or at its natural end. The lead's daily pass and the lane rollcall carry the reminder.
- **Order:** idle lanes first; then the lead (jp-eb) last, at a quiet minute; JP's own windowed sessions on katana/wakizashi whenever he next opens them (they are new processes anyway).
- The proxy keeps serving the old leaf throughout, so nothing breaks during this period.

### C — cutover (Fri 10/30 07:00–07:30 PDT)
1. Confirm no `claude` process on familiar, katana or wakizashi predates stage B. If any does, wait or restart it first.
2. On the VM, at 0 in-flight: `sudo rc-service teamclaude stop`, then `teamclaude certs rotate-mitm --commit` (it refuses while the proxy listens), then `sudo rc-service teamclaude start`. About 10 s down.
3. Verify:
   - the leaf served for `api.anthropic.com` has AKI, and its issuer is `TeamClaude MITM CA <hex>`;
   - Python strict passes: `SSL_CERT_FILE=…python-ca-bundle.pem python3 -c 'import urllib.request…'` gives an HTTP status, not an SSL error;
   - a lane round-trip on each host;
   - `/teamclaude/status` shows 7/7 active;
   - the VM log is free of TLS handshake failures.
4. Then JP or jp-eb may set `ENABLE_STOP_REVIEW=1` again, together with `SSL_CERT_FILE` in familiar's per-host `settings.local.json` (their decision; harness config).

### D — drop the old CA (≥ Fri 11/06)
Stop the proxy, `rotate-mitm --finish`, then start it. Rewrite the client files from the refreshed `teamclaude-mitm-trust.pem`: the new MITM CA only.

## Rollback
- **During B:** nothing to undo. Clients trust both CAs and the proxy still serves the old leaf.
- **During or after C:** on the VM at 0 in-flight, stop the proxy, run `rotate-mitm --rollback` (restores `.prev`), then start it. Clients still trust the old CA (dual trust until D), so they recover without any change. Backup: the stage-B tarball.
- **After D:** rollback needs the old CA put back into the client files first. Don't start D until C has run clean for a week.

## Risks
- **A lane that wasn't restarted** between B and C fails its handshakes at cutover. Mitigated by the stage-C check, and it's recoverable with a restart.
- **The CN collision**, if stage A's per-generation name were skipped. Hence the dual-trust test with a positive control.
- **Syncthing:** `~/.claude/settings.json` syncs, but the `~/.config/*.pem` files do not. Each host's file is edited by hand, three hosts.
