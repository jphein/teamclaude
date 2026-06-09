import http from 'node:http';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

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

export function createProxyServer(accountManager, config, hooks = {}) {
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

  // Wrap external hooks to also drive the activity feed
  const _hooks = hooks;
  hooks = {
    persistThreshold: _hooks.persistThreshold,
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

  const server = http.createServer(async (req, res) => {
    try {
      // Auth check — skip for localhost connections
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

      // Let client token refresh requests pass through to upstream untouched.
      // The proxy manages its own tokens via ensureTokenFresh(); intercepting
      // or rewriting client refreshes would cause token rotation conflicts.
      if (req.method === 'POST' && req.url === '/v1/oauth/token') {
        await relayRaw(req, res, upstream);
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
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
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
  });

  return server;
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(req, res, upstream) {
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  try {
    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
    });

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

async function writeRequestLog(logDir, reqId, sections) {
  if (!logDir) return;
  const ts = logTimestamp();
  const filename = `${ts}_${String(reqId).padStart(5, '0')}.log`;
  try {
    await writeFile(join(logDir, filename), sections.join('\n\n'), 'utf-8');
  } catch (err) {
    console.error(`[TeamClaude] Failed to write log: ${err.message}`);
  }
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir) {
  const maxRetries = accountManager.accounts.length;

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
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
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

  // Build log sections
  const logSections = [];
  if (logDir) {
    const safeHeaders = { ...headers };
    // Mask credentials in logs
    if (safeHeaders['x-api-key']) {
      safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    }
    if (safeHeaders['authorization']) {
      safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    }
    logSections.push(
      `=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`,
    );
    if (body.length > 0) {
      try {
        logSections.push(`=== REQUEST BODY ===\n${JSON.stringify(JSON.parse(body.toString()), null, 2)}`);
      } catch {
        logSections.push(`=== REQUEST BODY (${body.length} bytes) ===\n${body.toString().slice(0, 4096)}`);
      }
    }
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      redirect: 'manual',
    });

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    // On 429 this account is rate limited. Mark it so rotation skips it until it
    // resets, then retry on the NEXT account — that's the entire point of a
    // multi-account proxy. We must NOT block the client's open connection waiting
    // for retry-after: those windows can be minutes-to-hours, far past the
    // client's own timeout, which surfaces as an "API timeout" in Claude Code.
    if (upstreamRes.status === 429) {
      const retryAfter = parseInt(upstreamRes.headers.get('retry-after'), 10) || 60;
      // Read (don't discard) the 429 body so the *reason* is diagnosable. A
      // priority-pool/fast 429 is byte-identical to a quota 429 at the status
      // line; silently dropping the body is what made the fast-mode outage hard
      // to debug. Reading also drains the stream and frees the connection.
      let reason = '';
      try {
        const txt = await upstreamRes.text();
        try {
          const j = JSON.parse(txt);
          reason = j?.error?.message || j?.error?.type || '';
        } catch {
          reason = txt.slice(0, 200);
        }
      } catch { /* body already aborted/consumed */ }

      if (logDir) {
        logSections.push(`=== RESPONSE 429 — account "${account.name}" rate limited ${retryAfter}s ===\n${formatHeaders(upstreamRes.headers)}${reason ? `\n${reason}` : ''}`);
        writeRequestLog(logDir, reqId, logSections);
      }
      console.log(`[TeamClaude] 429 on "${account.name}" — rate limited ${retryAfter}s, rotating to next account${reason ? ` (${reason})` : ''}`);
      accountManager.markRateLimited(account.index, retryAfter);

      // Retry on the next available account. getActiveAccount() skips the account
      // we just throttled; if every account is limited it returns null and the
      // top-of-function guard responds with a 429 + retry-after for the client.
      if (retryCount < maxRetries && !res.headersSent && !res.destroyed) {
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      // Retries exhausted with everything limited — tell the client how long to wait.
      ctx.status = 429;
      if (!res.headersSent) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(retryAfter) });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: `All accounts rate limited. Retry in ${retryAfter}s.` },
        }));
      }
      return;
    }

    // Log response headers
    if (logDir) {
      logSections.push(`=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);
    }

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
      if (logDir) {
        logSections.push(`=== RESPONSE BODY ===\n(empty)`);
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end();
      return;
    }

    const isStreaming = (upstreamRes.headers.get('content-type') || '').includes('text/event-stream');

    if (isStreaming) {
      const streamLog = logDir ? [] : null;
      await streamResponse(upstreamRes.body, res, account.index, accountManager, streamLog);
      if (logDir) {
        logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
        writeRequestLog(logDir, reqId, logSections);
      }
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
      if (logDir) {
        try {
          logSections.push(`=== RESPONSE BODY ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`);
        } catch {
          logSections.push(`=== RESPONSE BODY (${buf.length} bytes) ===\n${buf.toString().slice(0, 8192)}`);
        }
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end(buf);
    }
  } catch (err) {
    // undici wraps the real reason in err.cause (the bare TypeError just says
    // "fetch failed"); surface it so transient failures are actually diagnosable.
    const cause = err?.cause;
    const causeStr = cause ? (cause.code || cause.message || String(cause)) : '';
    console.error(`[TeamClaude] Upstream error (account "${account.name}"):`, err.message, causeStr ? `(${causeStr})` : '');

    if (logDir) {
      const detail = cause ? `\nCause: ${cause.stack || causeStr}` : '';
      logSections.push(`=== ERROR ===\n${err.stack || err.message}${detail}`);
      writeRequestLog(logDir, reqId, logSections);
    }

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
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
    }

    // Non-transient error: this account/credential may be bad — mark it and try
    // the next account.
    if (!isTransient && retryCount < maxRetries) {
      account.status = 'error';
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
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
async function streamResponse(webStream, res, accountIndex, accountManager, streamLog) {
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

      const text = decoder.decode(value, { stream: true });

      // Capture for logging
      if (streamLog) streamLog.push(text);

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
