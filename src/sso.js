// Dashboard single sign-on through a trusted front proxy (Authelia's
// forward-auth behind Caddy, 2026-10-26).
//
// The front proxy authenticates the browser and names the person in a
// `Remote-User` header. A header is only as trustworthy as the hop that wrote
// it: anything on the LAN can send `Remote-User: jp` straight to this proxy. So
// the header is believed only when the request proves it came through that
// hop, three ways at once:
//   - the TCP peer is one of `proxy.sso.from` (the front proxy's address — a
//     socket address, never a forwarding header);
//   - it arrived over TLS (the listener on :3443), so the secret below never
//     crosses the network in clear; `requireTls: false` lifts this for a
//     front proxy on the same host;
//   - it carries `X-Teamclaude-Sso: <proxy.sso.secret>`, a value only the front
//     proxy holds (at least 32 characters, compared in constant time).
// And the named user must be one of `proxy.sso.users`, and the browser must
// say the dashboard page itself sent the request (Sec-Fetch-Site: same-origin).
//
// Only the dashboard's own routes honour it (/teamclaude/*, apart from the MCP
// endpoint): /v1/* and everything else stay key-only. A valid x-api-key still
// decides on its own; SSO only stands in for a missing or wrong one.

import { timingSafeEqual } from 'node:crypto';

export const SSO_SECRET_HEADER = 'x-teamclaude-sso';
export const SSO_USER_HEADER = 'remote-user';
export const SSO_MIN_SECRET = 32;
// Everything the front proxy may write about the person. Deleted from every
// request once the gate has read them, so none is ever relayed onward (the
// hop secret above all: Anthropic must never see it).
export const FRONT_PROXY_HEADERS = [SSO_SECRET_HEADER, SSO_USER_HEADER, 'remote-groups', 'remote-name', 'remote-email'];

/**
 * The SSO settings, or null when they are incomplete (then nobody is admitted
 * by SSO). Read per request, so a reload applies at once.
 * @param {any} proxyConfig
 * @returns {{ from: Set<string>, users: Set<string>, secret: string, requireTls: boolean } | null}
 */
export function ssoPolicy(proxyConfig) {
  const s = proxyConfig?.sso;
  if (!s || typeof s !== 'object') return null;
  const strings = (/** @type {any} */ v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  const from = strings(s.from).map(plainAddress);
  const users = strings(s.users);
  if (!from.length || !users.length) return null;
  if (typeof s.secret !== 'string' || s.secret.length < SSO_MIN_SECRET) return null;
  const requireTls = s.requireTls !== false;
  // Plain HTTP is for a front proxy on this machine only: across the network
  // the secret and the name would travel in clear (xreview, 2026-10-26).
  if (!requireTls && !from.every(isLoopbackAddress)) return null;
  return { from: new Set(from), users: new Set(users), secret: s.secret, requireTls };
}

/** @param {string} addr */
function isLoopbackAddress(addr) {
  return addr === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

/**
 * Whether a request carrying the sign-in shows positive proof that the
 * dashboard page itself sent it. The sign-in is a cookie scoped to the parent
 * domain, so a page on any sibling site (plan.realm.watch, …) rides it too:
 * `same-site` is not enough, and neither is the absence of browser headers —
 * which the key gate accepts from curl — since every browser sends them.
 * A navigation the person typed (`none`) may read, not write.
 * @param {import('node:http').IncomingMessage} req
 */
export function ssoSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin') return true;
  return site === 'none' && (req.method === 'GET' || req.method === 'HEAD');
}

/** Deletes the front proxy's headers from a request (see FRONT_PROXY_HEADERS). @param {import('node:http').IncomingHttpHeaders} headers */
export function stripFrontProxyHeaders(headers) {
  for (const h of FRONT_PROXY_HEADERS) delete headers[h];
}

/** Constant-time string equality (not imported from server.js, which imports this). @param {string} a @param {string} b */
function sameSecret(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** @param {string|undefined} addr */
function plainAddress(addr) {
  return String(addr || '').replace(/^::ffff:/i, '');
}

/**
 * Whether a request path may be admitted by SSO: the dashboard's control
 * plane, which is all the /ui page ever calls. Not the MCP endpoint (no
 * browser speaks it), and nothing outside /teamclaude/.
 * @param {string|undefined} url
 */
export function ssoEligiblePath(url) {
  const path = String(url || '').split('?', 1)[0];
  return path.startsWith('/teamclaude/') && path !== '/teamclaude/mcp' && !path.startsWith('/teamclaude/mcp/');
}

/**
 * Creates the per-server check. `log` reports, at most once a minute per
 * reason, a request that carried the hop secret header but was refused — the
 * one case worth an operator's attention (a misconfigured front proxy, or
 * someone guessing) — and the first admission of each user per hour.
 * @param {(msg: string) => void} [log]
 */
export function createSsoGate(log = console.log) {
  /** @type {Map<string, number>} */
  const lastLog = new Map();
  const once = (/** @type {string} */ key, /** @type {number} */ everyMs, /** @type {string} */ msg) => {
    const now = Date.now();
    if (now - (lastLog.get(key) || 0) < everyMs) return;
    if (lastLog.size > 100) lastLog.clear(); // bounded: reasons and users are few
    lastLog.set(key, now);
    log(msg);
  };

  /**
   * The signed-in user this request may act as (the operator), or null.
   * @param {import('node:http').IncomingMessage} req
   * @param {any} proxyConfig
   * @returns {string|null}
   */
  return function ssoUser(req, proxyConfig) {
    const presented = req.headers[SSO_SECRET_HEADER];
    if (presented === undefined) return null;
    const policy = ssoPolicy(proxyConfig);
    const peer = plainAddress(req.socket?.remoteAddress);
    /** @param {string} why */
    const refuse = (why) => { once(`refuse:${why}`, 60_000, `[TeamClaude] SSO header from ${peer || '?'} refused: ${why}`); return null; };
    if (!policy) return refuse('proxy.sso is not configured (from, users and a secret of 32+ characters)');
    if (!ssoEligiblePath(req.url)) return refuse('not a dashboard route');
    if (!policy.from.has(peer)) return refuse('not from a proxy.sso.from address');
    if (policy.requireTls && !(/** @type {any} */ (req.socket)?.encrypted)) return refuse('not over TLS (requireTls)');
    if (!ssoSameOrigin(req)) return refuse('not sent by the dashboard page (Sec-Fetch-Site)');
    if (typeof presented !== 'string' || !sameSecret(presented, policy.secret)) return refuse('wrong hop secret');
    const user = req.headers[SSO_USER_HEADER];
    // Compared whole, so joined duplicates ("jp, mallory") never match; only a
    // name from the operator's own list is ever logged.
    if (typeof user !== 'string' || !user) return refuse('no Remote-User');
    if (!policy.users.has(user)) return refuse('Remote-User is not in proxy.sso.users');
    once(`user:${user}`, 3_600_000, `[TeamClaude] Dashboard signed in via SSO as "${user}"`);
    return user;
  };
}
