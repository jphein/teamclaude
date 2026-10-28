# Backends

Every outside source TeamClaude talks to: the model providers it routes requests to, where its seats come from, the quota endpoints it reads, and the egress options it can use. Kept per JP's 2026-10-27 rule ("I want continually added backends to my projects"): each row says what it needs and its status, and a new one goes in through the normal gates (fixtures, a red perturbation, review, deploy). Any sign-up or plan upgrade is JP's one click.

**Measured 2026-10-27 19:2x PDT** against the code (master `a39c260`) and the live VM config (10.0.6.145). The "Live" column is what the deployed proxy uses right now, not what it could use.

Terms: TeamClaude pools **your own** accounts for **your own** agents. It is not a way to share accounts between people or to drive a subscription from another client. See [compliance.md](compliance.md) before adding any seat.

## Tier 1 — model providers TeamClaude routes to

| Backend | Account type | What it needs | Code + tests | Live |
|---|---|---|---|---|
| **Anthropic (Claude Team/Max seats)** | `oauth`, provider `anthropic` | A Claude seat per account (JP's TechEMPOWER Team org). Added by **＋ Add account** on /ui or `teamclaude login`. Re-auth by **Reauth** on /ui, which files an ask (key `claude-auth:<seat>`) | Core; thousands of tests | **Yes — 7 seats** (claude, claude2–6, jp) |
| **Anthropic API key** | `apikey`, provider `anthropic` | An API key (pay-as-you-go billing on the console org) | Yes | No |
| **Codex (ChatGPT plan seats)** | `oauth`, provider `codex` | A ChatGPT plan with Codex; `teamclaude login --codex`. Serves the **Codex CLI only** (compliance.md) | Yes (58 test files mention it) | No |
| **Anthropic-compatible third parties** (`accounts[].upstream`) | `apikey` with an `upstream` URL | That provider's key and plan | Routing: yes. Quota adapters: below | No |
| **Local failover — qwen36-coder** (llama-server on familiar:8091, Anthropic-native) | `failover.*` | familiar up with the model loaded | Yes (17 test files) | **Yes** — only when no seat can serve; labelled `qwen (failover)`, tool-less; `familiar` lanes excluded (#39) |

### Quota adapters for third-party upstreams (`src/backend-quota.js`)

| Provider host | Reads | Tests | Live |
|---|---|---|---|
| api.deepseek.com | balance (`/user/balance`) | 12 files | No |
| api.nano-gpt.com | subscription windows + routing advice (`/api/subscription/v1/usage`) | 2 | No |
| api.z.ai / open.bigmodel.cn | GLM Coding Plan monitor + console balance (raw-key `Authorization`) | 2 / 2 | No |
| api.kimi.com / api.kimi.ai | Kimi for Coding usages | 5 | No |
| api.moonshot.ai / api.moonshot.cn | balance | 2 | No |

## Tier 2 — not supported by TeamClaude (candidates)

These are Claude Code provider routes that JP switches with **claude-code-switcher** (`cc bedrock|vertex|foundry`), which bypasses TeamClaude entirely. TeamClaude itself has no code for them (no match for bedrock, vertex or foundry in `src/`).

| Backend | What it would need | Caveat | Status |
|---|---|---|---|
| **Amazon Bedrock** | AWS credentials, the Bedrock model IDs, SigV4 signing upstream | ⚠ Bills as AWS Marketplace, which the TechSoup credit does **not** cover (CLAUDE.md) | Not supported; `cc bedrock` routes around TeamClaude |
| **Google Vertex AI** | GCP project and region, a service account or ADC, Vertex model paths | Pay-per-use | Not supported; `cc vertex` routes around TeamClaude |
| **Anthropic on Azure AI Foundry** | Foundry resource and deployment, Entra/key auth | Pay-per-use | Not supported; `cc foundry` routes around TeamClaude |

Adding any of these means a provider in `src/provider.js` (upstream, auth, body rewrite), quota reading if the platform has one, and tests. None is planned: the seats are the cost-effective path, and failover covers the gaps.

## Tier 3 — quota and identity endpoints TeamClaude reads

| Endpoint | Used for | Notes |
|---|---|---|
| `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}` response headers | Per-seat 5 h / weekly quota on every response | The primary signal |
| `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1` | Quota probe (Refresh quotas, the probe timer) | Through `proxyFetch`: never follows redirects (#48) |
| `GET https://api.anthropic.com/api/oauth/profile` | Seat identity (account + org uuid) on login and reauth | The identity check that blocks a swapped seat |
| `POST https://platform.claude.com/v1/oauth/token` | Token exchange and refresh | Refresh tokens: never sent to a redirect (#48) |
| `https://claude.ai/oauth/authorize`, `console.anthropic.com/oauth/code/callback` | Browser sign-in (Add account, Reauth) | PKCE + state, localhost callback |
| `chatgpt.com/backend-api/wham/usage`, `…/rate-limit-reset-credits` | Codex quota and reset credits | Codex seats only |
| `auth.openai.com/oauth/{authorize,token}` | Codex sign-in and refresh | Codex seats only |

## Tier 4 — egress and support

| Backend | What it needs | Live |
|---|---|---|
| **sx.org** residential egress (`sx.*`) | An sx.org API key | No |
| **Pinned egress** (`egress.*`, checked via api.ipify.org) | Nothing beyond config | No |
| **Upstream proxy** (`upstreamProxy`, or one account's `routing`) | The proxy URL | No |

## Clients behind the MITM: Python (measured 2026-10-27)

Python tools that reach `api.anthropic.com` through `HTTPS_PROXY` meet TeamClaude's MITM leaf. Example: the security-guidance plugin's Stop-hook review, which failed CERTIFICATE_VERIFY_FAILED on every attempt today.
- **Trust:** Python does not read `NODE_EXTRA_CA_CERTS`. `~/.config/teamclaude-python-ca-bundle.pem` on familiar is the system CA bundle plus `teamclaude-ca.pem`. Rebuild it after a ca-certificates update with `cat /etc/ssl/certs/ca-certificates.crt ~/.config/teamclaude-ca.pem > ~/.config/teamclaude-python-ca-bundle.pem`. With `SSL_CERT_FILE` pointing at it, ordinary HTTPS through the proxy verifies (pypi.org: 200).
- **Still failing on Python ≥ 3.13:** "Missing Authority Key Identifier". Python verifies in strict X.509 mode, and the MITM chain (CA issued 2026-06-23) predates #19, which added SKI/AKI only to certificates issued after it. The fix is reissuing the MITM CA with key identifiers. That is a planned migration: every MITM client trusts the current CA (familiar's and katana's `NODE_EXTRA_CA_CERTS`, the forwarder's lanes), so all must move to the new CA together.
- **Not set anywhere yet:** `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` are not in any settings file. Setting them alone would not fix the review (strict mode, above).

## Adding a backend

One adapter per idle slot, through the normal gates: fixtures from the provider's real replies, a red perturbation, one independent review (Foundry xreview for anything security-relevant), CI, deploy at zero in-flight. Then update the table above with the date measured.
