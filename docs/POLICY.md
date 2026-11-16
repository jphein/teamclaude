# Policy note: Anthropic's authentication terms and this fork's deployment

Recorded 2026-11-16 (teamclaude lane, at the fleet lead's request). JP was told at 15:5x. **This note records text and facts; it decides nothing and changes no behaviour.** Whether to keep running as below is JP's decision. The general stance of the upstream project is in [compliance.md](compliance.md).

## The source

<https://code.claude.com/docs/en/legal-and-compliance>, read 2026-11-16. The quotes below are verbatim, under the page's own headings.

Under **Usage policy → Acceptable use**:

> Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK.

Under **Usage policy → Authentication and credential use**:

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

> For questions about permitted authentication methods for your use case, please contact sales.

The page's route for questions is [contact sales](https://www.anthropic.com/contact-sales).

## What this deployment does

Stated plainly, without arguing either way:

- **It stores seat tokens.** The proxy VM (10.0.6.145) keeps the OAuth access and refresh tokens of seven TechEMPOWER **Team** seats in its config and refreshes them itself.
- **It routes many sessions through them.** Each client host's forwarder sends Claude Code traffic to the proxy: JP's desktops and the fleet's agent lanes. The proxy picks a seat per request or conversation and substitutes that seat's token. Many concurrent sessions, most of them agent lanes rather than a person typing, are served through the seven seats.
- **It acts on the seats itself.** It reads each seat's usage and banked resets, may spend a banked reset (`autoRedeemResets`, the reset rules, the operator's `resets redeem`), and may send keep-warm requests.
- **It is one customer's own seats.** The seats, the hosts and the people are TechEMPOWER's. The proxy is not offered to anyone outside it, and no seat is resold.

## What the text does not settle

- The "on behalf of their users" sentence names **Free, Pro, Max, or Ultra** credentials, and the "ordinary, individual usage" sentence names **Pro, Max, and Ultra**. Neither names **Team**. The OAuth sentence does name Team, as "intended exclusively for purchasers of … Team … subscription plans" and "designed to support ordinary use of Claude Code".
- The "may not collect, store, or intermediate Claude.ai credentials or session tokens" sentence is written about **developers** building products for **their users**. Whether a customer that runs a proxy over its own seats for its own people and agents counts as such a developer is **not settled by the text**.
- Whether many agent sessions pooled across seven Team seats is "ordinary use of Claude Code" is likewise **not settled by the text**.
- Enforcement "may" come "without prior notice". The proxy cannot detect or predict it.

The page names contacting sales as the way to get an answer for a specific use case.
