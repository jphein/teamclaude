import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { ensureCerts, createConnectHandler } from './mitm.js';
import { patchAccountUuid } from './account-uuid-rewrite.js';
import { BodyWriter } from './request-log.js';
import { upstreamFetch } from './upstream-fetch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

/**
 * Fast mode (Claude Code's /fast) sets `"speed": "fast"` in the request body and
 * a `fast-mode-*` token in the anthropic-beta header. It routes through a separate
 * priority-tier pool that, for subscription seats, bills as usage credits and is
 * NOT covered by the subscription rate limits. A seat without credits gets a 429
 * on EVERY fast request, regardless of account — which this proxy would otherwise
 * misread as quota exhaustion and use to rate-limit every account in turn (one
 * /fast keystroke takes the whole pool offline). We strip fast mode so the request
 * runs as standard Opus and can never poison the account pool. Returns the body to
 * forward (a new Buffer if modified, otherwise the original) and mutates `headers`.
 */
function stripFastMode(body, headers) {
  if (!body || body.length === 0) return body;
  let parsed;
  try {
    parsed = JSON.parse(body.toString());
  } catch {
    return body; // not JSON (shouldn't happen for /v1/messages) — leave untouched
  }
  if (parsed?.speed !== 'fast') return body;

  delete parsed.speed;

  // Drop the fast-mode-* beta token; harmless once speed is gone, but cleaner.
  const beta = headers['anthropic-beta'];
  if (typeof beta === 'string') {
    const kept = beta.split(',').map(s => s.trim()).filter(s => s && !s.startsWith('fast-mode'));
    if (kept.length) headers['anthropic-beta'] = kept.join(',');
    else delete headers['anthropic-beta'];
  }

  console.log('[TeamClaude] Stripped fast mode (speed:"fast") — unavailable on subscription seats (usage-credit only); downgrading to standard Opus');
  const newBody = Buffer.from(JSON.stringify(parsed));
  // The body shrank — re-sync content-length or undici aborts the forwarded
  // request with UND_ERR_REQ_CONTENT_LENGTH_MISMATCH.
  if ('content-length' in headers) headers['content-length'] = String(newBody.length);
  return newBody;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function createProxyServer(accountManager, config, hooks = {}, sx = null) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  let requestCounter = 0;
  let dashboardHtml = null;

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  // Activity feed: ring buffer + SSE subscribers
  const activityBuf = [];
  const activityClients = new Set();
  const reqStartTimes = new Map();

  function emitActivity(event) {
    const e = { ...event, ts: Date.now() };
    activityBuf.push(e);
    if (activityBuf.length > 500) activityBuf.shift();
    const msg = `data: ${JSON.stringify(e)}\n\n`;
    for (const sub of activityClients) {
      try { sub.write(msg); } catch { activityClients.delete(sub); }
    }
  }

  // Wrap external hooks to also drive the activity feed. Spread the originals
  // first so non-instrumented hooks (persistThreshold, onManualSwitch, reload)
  // pass straight through; only the three request-lifecycle hooks are overridden.
  const _hooks = hooks;
  hooks = {
    ..._hooks,
    onRequestStart(id, info) {
      _hooks.onRequestStart?.(id, info);
      reqStartTimes.set(id, Date.now());
      emitActivity({ type: 'req_start', id, method: info.method, path: info.path });
    },
    onRequestRouted(id, info) {
      _hooks.onRequestRouted?.(id, info);
      emitActivity({ type: 'req_routed', id, account: info.account });
    },
    onRequestEnd(id, info) {
      const ms = reqStartTimes.has(id) ? Date.now() - reqStartTimes.get(id) : null;
      reqStartTimes.delete(id);
      _hooks.onRequestEnd?.(id, info);
      emitActivity({ type: 'req_end', id, method: info.method, path: info.path, account: info.account, status: info.status, ms });
    },
  };

  const requestHandler = async (req, res) => {
    try {
      // Auth check — skip for localhost connections.
      const clientKey = req.headers['x-api-key'];
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if (proxyApiKey && clientKey !== proxyApiKey && !isLocal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }

      // Parse pathname once for control-endpoint matching (ignores query string / fragment)
      const pathname = new URL(req.url, 'http://localhost').pathname;

      // Status endpoint
      if (req.method === 'GET' && pathname === '/teamclaude/status') {
        const status = accountManager.getStatus();
        status.upstream = upstream;
        status.port = config.proxy?.port;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status, null, 2));
        return;
      }

      // POST /teamclaude/switch — manually pin the active account
      if (req.method === 'POST' && pathname === '/teamclaude/switch') {
        try {
          const { account } = JSON.parse((await readBody(req)) || '{}');
          if (!account) { json(res, 400, { error: 'Missing "account"' }); return; }
          const idx = accountManager.accounts.findIndex(a => a.name === account);
          if (idx < 0) { json(res, 404, { error: `Account "${account}" not found` }); return; }
          accountManager.currentIndex = idx;
          console.log(`[TeamClaude] Manually switched to "${account}"`);
          hooks.onManualSwitch?.(account);
          emitActivity({ type: 'switched', account });
          json(res, 200, { currentAccount: account });
        } catch (err) {
          json(res, 400, { error: err.message });
        }
        return;
      }

      // POST /teamclaude/threshold — change the rotation threshold (0..1)
      if (req.method === 'POST' && pathname === '/teamclaude/threshold') {
        try {
          const { value } = JSON.parse((await readBody(req)) || '{}');
          const v = Number(value);
          if (Number.isNaN(v) || v < 0 || v > 1) {
            json(res, 400, { error: 'value must be a number between 0 and 1' });
            return;
          }
          accountManager.switchThreshold = v;
          await hooks.persistThreshold?.(v);
          console.log(`[TeamClaude] Threshold set to ${(v * 100).toFixed(0)}%`);
          emitActivity({ type: 'threshold', value: v });
          json(res, 200, { switchThreshold: v });
        } catch (err) {
          json(res, 400, { error: err.message });
        }
        return;
      }

      // GET /teamclaude/activity — SSE stream of request lifecycle events
      if (req.method === 'GET' && pathname === '/teamclaude/activity') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        // Replay recent terminal events (not in-flight req_start which may be stale)
        const replayTypes = new Set(['req_end', 'switched', 'threshold']);
        for (const e of activityBuf.filter(e => replayTypes.has(e.type)).slice(-100)) {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        }
        activityClients.add(res);
        req.on('close', () => activityClients.delete(res));
        return;
      }

      // GET /teamclaude/logs — SSE stream of journald output
      if (req.method === 'GET' && pathname === '/teamclaude/logs') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const child = spawn('journalctl', [
          '--user', '-u', 'teamclaude.service',
          '-n', '100', '-f', '--no-pager', '--output=short-iso',
        ]);
        child.stdout.on('data', chunk => {
          for (const line of chunk.toString().split('\n')) {
            if (line.trim()) res.write(`data: ${JSON.stringify(line)}\n\n`);
          }
        });
        req.on('close', () => child.kill());
        child.on('exit', () => { if (!res.writableEnded) res.end(); });
        return;
      }

      // POST /teamclaude/restart — fire-and-forget service restart
      if (req.method === 'POST' && pathname === '/teamclaude/restart') {
        json(res, 200, { restarting: true });
        setImmediate(() => {
          const child = spawn('systemctl', ['--user', 'restart', 'teamclaude.service'], {
            detached: true, stdio: 'ignore',
          });
          child.unref();
        });
        return;
      }

      // GET /ui — serve the dashboard (single-page HTML, cached after first read)
      if (req.method === 'GET' && (pathname === '/ui' || pathname === '/ui/' || pathname === '/ui/index.html')) {
        try {
          if (dashboardHtml === null) {
            dashboardHtml = await readFile(join(__dirname, 'web', 'index.html'), 'utf-8');
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(dashboardHtml);
        } catch (err) {
          json(res, 500, { error: `Dashboard not found: ${err.message}` });
        }
        return;
      }

      // Reload endpoint — re-sync accounts from config without a restart. This
      // is the headless equivalent of pressing 'R' in the TUI. Local control
      // only (no upstream calls); the auth gate above already applies.
      if (req.method === 'POST' && req.url === '/teamclaude/reload') {
        if (!hooks.reload) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'reload not supported' }));
          return;
        }
        try {
          const added = await hooks.reload();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, added: added || 0 }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // Plain-HTTP proxy requests to non-upstream hosts (e.g. GET http://familiar:8085/...).
      // Subprocesses that inherit HTTP_PROXY may not respect NO_PROXY, so rather than
      // rejecting these, forward them directly as a standard HTTP proxy would.
      if (req.url.startsWith('http://') || req.url.startsWith('https://')) {
        const target = new URL(req.url);
        const upHost = new URL(upstream).hostname;
        if (target.hostname !== upHost) {
          const fwdHeaders = { ...req.headers };
          delete fwdHeaders['proxy-authorization'];
          delete fwdHeaders['proxy-connection'];
          fwdHeaders.host = target.host;
          const fwd = http.request(req.url, { method: req.method, headers: fwdHeaders }, (fwdRes) => {
            res.writeHead(fwdRes.statusCode, fwdRes.headers);
            fwdRes.pipe(res);
          });
          fwd.on('error', (err) => {
            console.error(`[TeamClaude] Proxy passthrough failed: ${req.method} ${req.url}: ${err.message}`);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
            }
          });
          req.pipe(fwd);
          return;
        }
      }

      // Let client token refresh requests pass through to upstream untouched.
      // The proxy manages its own tokens via ensureTokenFresh(); intercepting
      // or rewriting client refreshes would cause token rotation conflicts.
      if (req.method === 'POST' && req.url === '/v1/oauth/token') {
        await relayRaw(req, res, upstream, sx);
        return;
      }

      // Track request
      const reqId = ++requestCounter;
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      // Buffer request body (needed for retry on 429)
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      // Strip fast mode before forwarding — it always 429s on subscription seats
      // and would otherwise rate-limit every account (see stripFastMode).
      const body = stripFastMode(Buffer.concat(bodyChunks), req.headers);

      const ctx = { account: null, status: null };
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir, sx);
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[TeamClaude] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'proxy_error', message: 'Internal proxy error' },
          }));
        }
      } finally {
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status,
        });
      }
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  };

  const server = http.createServer(requestHandler);

  // Forward-proxy support (always on, so multiple claude instances can use
  // either ANTHROPIC_BASE_URL or HTTPS_PROXY against the same server). A CONNECT
  // to the upstream host is a transparent MITM relay (rewrite only auth); the
  // test host is answered locally; anything else is blind-tunneled. Certs are
  // minted lazily on the first intercepted CONNECT.
  const mitmHost = (() => { try { return new URL(upstream).hostname; } catch { return 'api.anthropic.com'; } })();
  let certsPromise = null;
  const ensureLeaf = async () => {
    certsPromise ||= ensureCerts(mitmHost);
    const c = await certsPromise;
    return { key: c.leafKeyPem, cert: c.leafCertPem };
  };
  const connectHandler = createConnectHandler({ config, accountManager, ensureLeaf, logDir, hooks, log: console.error, sx });
  server.on('connect', (req, clientSocket, head) => {
    const ra = clientSocket.remoteAddress;
    const isLocal = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (proxyApiKey && !isLocal) {
      const m = /^Basic\s+(.+)$/i.exec(req.headers['proxy-authorization'] || '');
      const provided = m ? Buffer.from(m[1], 'base64').toString().split(':').pop() : null;
      if (provided !== proxyApiKey) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="teamclaude"\r\n\r\n');
        clientSocket.destroy();
        return;
      }
    }
    connectHandler(req, clientSocket, head);
  });

  return server;
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(req, res, upstream, sx) {
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  try {
    const upstreamRes = await upstreamFetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
    }, sx, sx?.useByDefault());

    const responseBody = await upstreamRes.text();
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    console.error('[TeamClaude] Raw relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  }
}


function logTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// A per-request log that streams to disk as the request/response flow, instead
// of buffering the whole body in memory and writing once at the end. The file
// is opened on first write; header sections are written verbatim and bodies are
// streamed through BodyWriter (JSON pretty-printed on the fly, SSE/other raw),
// so even a ~1M-token response costs only the current chunk.
function openRequestLog(logDir, reqId) {
  const filename = `${logTimestamp()}_${String(reqId).padStart(5, '0')}.log`;
  const ws = createWriteStream(join(logDir, filename), { flags: 'a' });
  ws.on('error', (err) => console.error(`[TeamClaude] Failed to write log: ${err.message}`));
  let ended = false;
  const write = (s) => { if (!ended && s) ws.write(Buffer.from(String(s), 'latin1')); };
  return {
    write,
    // Stream a complete body buffer under a section header.
    body(label, buf, contentType) {
      if (!buf || !buf.length) { write(`\n\n=== ${label} ===\n(empty)`); return; }
      new BodyWriter(write, label, contentType || '').chunk(buf);
    },
    // A BodyWriter to append chunks incrementally (e.g. an SSE response).
    bodyWriter(label, contentType) { return new BodyWriter(write, label, contentType || ''); },
    end() { if (!ended) { ended = true; ws.end('\n'); } },
  };
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, useSx) {
  const maxRetries = accountManager.accounts.length;
  // Whether THIS attempt dials via sx.org. Undefined on the first call → derive
  // from the default policy ('always' routes; 'off'/'429' start direct).
  const route = useSx === undefined ? !!(sx?.useByDefault()) : useSx;

  // Select account
  const account = accountManager.getActiveAccount();
  if (!account) {
    ctx.status = 429;
    ctx.account = '(none available)';
    const status = accountManager.getStatus();
    const retryAfter = computeRetryAfter(status.accounts);
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': String(retryAfter),
    });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `All ${accountManager.accounts.length} accounts exhausted. Retry in ${retryAfter}s.`,
      },
    }));
    return;
  }

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed
  await accountManager.ensureTokenFresh(account.index);
  if (account.status === 'error' && retryCount < maxRetries) {
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
  }

  // Build upstream request headers
  const isOAuth = account.type === 'oauth';
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk)) continue;
    if (lk === 'x-api-key') continue;
    // Strip accept-encoding: Node fetch auto-decompresses, which would
    // mismatch the Content-Encoding header we forward to the client
    if (lk === 'accept-encoding') continue;
    headers[key] = value;
  }

  if (isOAuth) {
    headers['authorization'] = `Bearer ${account.credential}`;
  } else {
    headers['x-api-key'] = account.credential;
  }

  const upstreamUrl = `${upstream}${req.url}`;
  const method = req.method;

  // Align the body's account_uuid (in metadata.user_id) with the account whose
  // token we're injecting (same-length patch; no-op if absent).
  const sendBody = account.accountUuid ? patchAccountUuid(body, account.accountUuid) : body;

  // Streaming request log, opened lazily on the first terminal outcome (a
  // pure-429-then-retry attempt writes no file, matching prior behavior). The
  // request head+body are written once, just before the response is logged.
  let log = null;
  let reqLogged = false;
  const getLog = () => (logDir ? (log ||= openRequestLog(logDir, reqId)) : null);
  const logRequestHead = () => {
    const l = getLog();
    if (!l || reqLogged) return;
    reqLogged = true;
    const safeHeaders = { ...headers };
    if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    if (safeHeaders['authorization']) safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    l.write(`=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`);
    if (body.length > 0) l.body('REQUEST BODY', body, req.headers['content-type']);
  };

  try {
    const upstreamRes = await upstreamFetch(upstreamUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : sendBody,
      redirect: 'manual',
    }, sx, route);

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    // On 429, wait the retry-after duration and retry on the same account
    // (this is a transient rate limit, not quota exhaustion).
    if (upstreamRes.status === 429) {
      // Clamp Retry-After to a sane window: missing/invalid falls back to 60s,
      // and out-of-range values are bounded to [1, 300]. A negative value would
      // otherwise bypass the retry cap — setTimeout returns immediately and
      // markRateLimited would set rateLimitedUntil in the past.
      let retryAfter = parseInt(upstreamRes.headers.get('retry-after'), 10);
      if (Number.isNaN(retryAfter)) retryAfter = 60;
      retryAfter = Math.min(Math.max(retryAfter, 1), 300);
      // Discard the 429 response body
      await upstreamRes.body?.cancel();

      // sx.org failover: 429s are IP-based, so retry via the proxy's egress IP.
      // 'always' is already on sx; '429' switches direct→sx now and skips the
      // wait (a fresh IP isn't throttled). Also arm the sticky window for MITM.
      const nextUseSx = !!(sx?.useOn429());
      const switchingToSx = nextUseSx && !route;
      sx?.noteRateLimited(retryAfter);

      // Bound the retries: a persistently-throttled upstream must not loop
      // forever (that would tie up the client connection indefinitely).
      // Once retries are exhausted, throttle this account and re-dispatch —
      // getActiveAccount then picks another account, or returns 429 to the
      // client if every account is throttled.
      if (retryCount >= maxRetries) {
        console.log(`[TeamClaude] Persistent 429 on "${account.name}" — throttling ${retryAfter}s and re-dispatching`);
        accountManager.markRateLimited(account.index, retryAfter);
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
      }

      if (switchingToSx) {
        console.log(`[TeamClaude] 429 on "${account.name}" — retrying via sx.org (fresh egress IP)`);
      } else {
        console.log(`[TeamClaude] 429 on "${account.name}" — waiting ${retryAfter}s before retry`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      }
      // Client may have disconnected during the wait
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
    }

    // Log the request head (once) followed by the response headers, streaming
    // to disk from here on.
    logRequestHead();
    getLog()?.write(`\n\n=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);

    ctx.status = upstreamRes.status;

    // Build response headers (skip hop-by-hop and encoding headers)
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      // Strip content-encoding/content-length since fetch may auto-decompress
      if (key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }

    res.writeHead(upstreamRes.status, responseHeaders);

    if (!upstreamRes.body) {
      const l = getLog();
      if (l) { l.write('\n\n=== RESPONSE BODY ===\n(empty)'); l.end(); }
      res.end();
      return;
    }

    const contentType = upstreamRes.headers.get('content-type') || '';
    const isStreaming = contentType.includes('text/event-stream');

    if (isStreaming) {
      // Stream each chunk straight to the log as it is relayed — never hold the
      // whole (potentially ~1M-token) SSE body in memory.
      const l = getLog();
      const bw = l ? l.bodyWriter('RESPONSE BODY (streamed)', contentType) : null;
      await streamResponse(upstreamRes.body, res, account.index, accountManager, bw);
      l?.end();
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
      const l = getLog();
      if (l) { l.body('RESPONSE BODY', buf, contentType); l.end(); }
      res.end(buf);
    }
  } catch (err) {
    // undici wraps the real reason in err.cause (the bare TypeError just says
    // "fetch failed"); surface it so transient failures are actually diagnosable.
    const cause = err?.cause;
    const causeStr = cause ? (cause.code || cause.message || String(cause)) : '';
    console.error(`[TeamClaude] Upstream error (account "${account.name}"):`, err.message, causeStr ? `(${causeStr})` : '');

    logRequestHead();
    const l = getLog();
    if (l) { l.write(`\n\n=== ERROR ===\n${err.stack || err.message}`); l.end(); }

    // The network-level error code lives on err.cause.code for fetch() failures,
    // not on err.code — check both.
    const code = err?.code || cause?.code;
    const isTransient = err instanceof Error &&
      (err.message.includes('fetch failed') ||
        err.message.includes('terminated') ||
        code === 'ECONNRESET' || code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' ||
        code === 'UND_ERR_SOCKET');

    // If we've already started sending a response (mid-stream failure) or the
    // client has gone away, we can't recover — just finish up.
    if (res.headersSent || res.destroyed) {
      if (!res.writableEnded) res.end();
      return;
    }

    // Transient connection failure (stale keep-alive socket, network blip).
    // Retrying re-establishes a fresh connection — which is exactly what defeats
    // a stale pooled socket — so retry the SAME account (the credential is fine,
    // the connection wasn't). Bounded attempts with short backoff. Crucially we
    // do NOT res.destroy() the client: dropping the socket is what Claude Code
    // sees as an "API timeout".
    if (isTransient && retryCount < maxRetries) {
      const delay = Math.min(200 * 2 ** retryCount, 2000);
      await new Promise(resolve => setTimeout(resolve, delay));
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    // Non-transient error: this account/credential may be bad — mark it and try
    // the next account.
    if (!isTransient && retryCount < maxRetries) {
      account.status = 'error';
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    // Retries exhausted — return a clean, retryable error. Never destroy the
    // socket; a proper 502 lets the client retry gracefully.
    ctx.status = 502;
    res.writeHead(502, { 'Content-Type': 'application/json', 'retry-after': '1' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'proxy_error', message: `Upstream error after ${retryCount + 1} attempt(s): ${err.message}` },
    }));
  }
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, accountIndex, accountManager, bodyWriter) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      // Forward chunk immediately
      const ok = res.write(value);

      // Append to the log as it streams (no whole-body buffering)
      if (bodyWriter) bodyWriter.chunk(Buffer.from(value));

      const text = decoder.decode(value, { stream: true });

      // Parse SSE events for usage tracking
      sseBuffer += text;
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop(); // keep incomplete event

      for (const event of events) {
        parseSSEUsage(event, accountIndex, accountManager);
      }

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket
      if (!ok) {
        await new Promise(resolve => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
        if (res.destroyed) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, accountIndex, accountManager);
    }
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

function parseSSEUsage(event, accountIndex, accountManager) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      accountManager.updateUsage(accountIndex, data.message.usage.input_tokens, 0);
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens);
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, accountIndex, accountManager) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(accountIndex, json.usage.input_tokens, json.usage.output_tokens);
    }
  } catch {
    // not JSON or no usage
  }
}

function computeRetryAfter(accounts) {
  let soonest = Infinity;
  for (const acct of accounts) {
    const reset = acct.rateLimitedUntil || acct.quota.resetsAt;
    if (reset) {
      const ms = new Date(reset).getTime() - Date.now();
      if (ms < soonest) soonest = ms;
    }
  }
  return soonest === Infinity ? 60 : Math.max(1, Math.ceil(soonest / 1000));
}
