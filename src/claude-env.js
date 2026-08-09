// Percent-encode an account name (or key) for a URL, leaving ONLY the unreserved
// set. encodeURIComponent alone is not enough here: it passes `( ) ' ! *`
// through untouched, and these lines are emitted as unquoted shell `export`
// statements for `eval "$(teamclaude env)"` — a name like "work (Acme)" would be
// a shell syntax error. Clients percent-decode userinfo before using it
// (verified against Claude Code 2.1.220), so the extra escaping is transparent.
export function encodePinComponent(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Build the shell `export` lines that point Claude Code — or any tool that
// spawns it, e.g. an agent multiplexer — at the proxy. This is the same
// environment `teamclaude run` sets up, but emitted for `eval "$(teamclaude
// env)"` instead of launching claude directly. Pure and side-effect free so it
// can be unit-tested; the caller resolves the port, cert path, and holdSeconds.
//
// MITM (forward-proxy) mode is the default, matching `teamclaude run`: it routes
// ALL of claude's traffic through the proxy — even hardcoded api.anthropic.com
// endpoints (e.g. the design MCP) — with claude trusting our leaf via
// NODE_EXTRA_CA_CERTS. base-URL mode only redirects the Anthropic base URL and
// leaves other hosts alone.
//
// No ANTHROPIC_API_KEY is emitted: loopback clients are exempt from the proxy's
// key gate, and setting it would drop Claude Code out of subscription mode (and
// its full model access). Remote clients that aren't on loopback must add the
// proxy key themselves.
// `account` pins the session to one account (TC_ACCT), exactly as `teamclaude
// run` does: in MITM mode it rides in the proxy URL's userinfo and reaches the
// proxy as the CONNECT's Basic username; in base-URL mode it becomes a
// `/tc-acct/` prefix. TC_ACCT itself is then unset, so the pin does not leak
// into claude or anything it spawns — same reasoning as `run` deleting it from
// the child environment.
export function buildClaudeEnvLines({ port, useMitm = true, caPath = null, holdSeconds = 0, account = null, proxyApiKey = '' }) {
  const lines = [];
  const pin = (account || '').trim();

  if (useMitm) {
    const userinfo = pin ? `${encodePinComponent(pin)}:${encodePinComponent(proxyApiKey || '')}@` : '';
    const proxyUrl = `http://${userinfo}127.0.0.1:${port}`;
    lines.push(
      `export HTTPS_PROXY=${proxyUrl}`,
      `export HTTP_PROXY=${proxyUrl}`,
      `export https_proxy=${proxyUrl}`,
      `export http_proxy=${proxyUrl}`,
      // 🔴 The proxy is a BLANKET http(s)_proxy, so every client that inherits this
      // env routes ALL its HTTP through :3456 — not just Claude's Anthropic traffic.
      // Internal homelab traffic (cameras on 10.0.10/24, the local llama-server and
      // mempalace on familiar, *.jphe.in, *.realm.watch) is NOT Anthropic traffic and
      // must go direct. This NO_PROXY is purely ADDITIVE: adding hosts can only make
      // MORE targets bypass — api.anthropic.com is not listed, so it still proxies.
      // Both CIDR (curl/requests) and bare hostnames/suffixes (urllib/node) are given
      // because client NO_PROXY parsers differ. (2026-08-09: internal HTTP was being
      // intercepted — teamclaude logged ECONNREFUSED forwarding to a camera and to
      // familiar:8085.)
      'export NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.jphe.in,.realm.watch,.local,familiar,disks,ubox0,nodered,game,katana,gatekeeper',
      'export no_proxy=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.jphe.in,.realm.watch,.local,familiar,disks,ubox0,nodered,game,katana,gatekeeper',
    );
    if (caPath) lines.push(`export NODE_EXTRA_CA_CERTS=${caPath}`);
    // Clear any stale base-URL so the two modes don't stack in one shell.
    lines.push('unset ANTHROPIC_BASE_URL');
  } else {
    const prefix = pin ? `/tc-acct/${encodePinComponent(pin)}` : '';
    lines.push(`export ANTHROPIC_BASE_URL=http://localhost:${port}${prefix}`);
  }

  // The pin is now carried by the routing itself; keep it out of the child.
  if (pin) lines.push('unset TC_ACCT');

  // Parity with `run`: if the proxy may hold the connection on exhaustion, raise
  // the client-side timeout so it doesn't give up mid-hold.
  const holdMs = (holdSeconds || 0) * 1000;
  if (holdMs > 0) lines.push(`export API_TIMEOUT_MS=${holdMs + 60_000}`);

  return lines;
}
