// The Settings view's single source of truth: every key teamclaude reads from
// its config, with a group, a one-line explanation, its default, how to
// validate it, and whether a saved change applies live (`hot`) or only after a
// restart (`restart`). /teamclaude/settings serves this to the dashboard, and
// test/settings-schema.test.js fails when the code or docs/configuration.md
// gain a key that is missing here — so the Settings view stays complete.
//
// Two rules the whole file keeps:
//   * Secrets are write-only. A secret's value never leaves the server: it is
//     reported as "set"/"not set", and the MASK sentinel on a save means "keep
//     what is there". OAuth tokens and account credentials are not settings at
//     all and are never read here.
//   * Hot means exactly what the server re-reads on reload (index.js
//     reloadAccounts, sync-accounts.js). Everything else says "needs restart",
//     because the running process would keep the old value.

import { copyFile, chmod, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { atomicConfigUpdate, getConfigPath } from './config.js';
import { resolveTlsConfig } from './tls-listener.js';
import { validateAdaptiveConfig } from './adaptive-distribution.js';
import { resolveWarmupSchedule } from './warmup-schedule.js';
import { parseProxyUrl } from './upstream-proxy.js';
import { resolveLogSource, resolveRestartMethod } from './service-control.js';

/** Sent in place of a secret, and accepted back on a save as "unchanged". */
export const MASK = '••••••••';

/** @typedef {'bool'|'int'|'number'|'enum'|'text'|'list'|'json'|'secret'|'secretList'} FieldType */
/**
 * @typedef {Object} Field
 * @property {string} key       dot path into the config ("proxy.port")
 * @property {string} [group]  (every FIELDS entry has one; account fields do not)
 * @property {string} label
 * @property {string} help      one plain-language line
 * @property {any} def          the default the server uses when the key is unset
 * @property {FieldType} type
 * @property {'hot'|'restart'} apply
 * @property {any[]} [options]  enum values
 * @property {number} [min]
 * @property {number} [max]
 * @property {boolean} [credUrl] a URL whose userinfo (user:password@) is masked like a secret
 * @property {boolean} [danger] changes where traffic or tokens go, or runs a program
 * @property {(v: any, cfg: any) => string|null} [check] extra validation; returns a problem or null
 */

/** @param {any} v */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {any} v */
const thresholdCheck = (v) => {
  /** @param {any} n */
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1;
  if (ok(v)) return null;
  if (isObj(v) && Object.keys(v).length && Object.values(v).every(ok)) return null;
  return 'must be a number above 0 and at most 1, or an object of bucket → number';
};

/** @type {Field[]} */
export const FIELDS = [
  // ── Rotation & quota ─────────────────────────────────────────────────────
  { key: 'switchThreshold', group: 'Rotation & quota', label: 'Switch threshold', type: 'json', apply: 'hot', def: 0.98,
    help: 'Quota use (0–1) at which an account counts as spent and traffic moves on. A number, or a per-bucket table.', check: thresholdCheck },
  { key: 'quotaProbeSeconds', group: 'Rotation & quota', label: 'Quota probe interval (s)', type: 'int', apply: 'hot', def: 0, min: 0, max: 7 * 24 * 3600,
    help: 'Re-read every account\'s quota from the zero-cost usage endpoint this often. 0 = off.',
    check: (v) => (v > 0 && v < 30 ? 'must be 0 (off) or at least 30' : null) },
  { key: 'holdSeconds', group: 'Rotation & quota', label: 'Hold when all spent (s)', type: 'int', apply: 'restart', def: 0, min: 0,
    help: 'When every account is spent, hold the request this long waiting for one to recover. 0 = answer 429 at once.' },
  { key: 'blockedModels', group: 'Rotation & quota', label: 'Blocked models', type: 'list', apply: 'hot', def: [],
    help: 'Model name patterns (e.g. *fable*) refused with a fast 400 instead of being sent upstream.' },
  { key: 'stormRamp', group: 'Rotation & quota', label: 'Storm ramp', type: 'json', apply: 'restart',
    def: { enabled: true, startConc: 1, stepConc: 1, stepMs: 250, windowMs: 30000 },
    help: 'After a switch, ramp concurrent requests onto the new account gradually instead of all at once.',
    check: (v) => (isObj(v) ? null : 'must be an object { enabled, startConc, stepConc, stepMs, windowMs }') },

  // ── Routing ─────────────────────────────────────────────────────────────
  { key: 'distributeSessions', group: 'Routing', label: 'Distribute sessions', type: 'enum', apply: 'hot', def: false, options: [false, true, 'adaptive'],
    help: 'Spread sessions across EQUAL-priority accounts (true), or by plan tier and load (adaptive). Off = one account at a time.' },
  { key: 'adaptiveDistribution', group: 'Routing', label: 'Adaptive tuning', type: 'json', apply: 'restart', def: {},
    help: 'Optional numbers that tune adaptive distribution. Leave empty for the defaults.',
    check: (v) => { try { validateAdaptiveConfig(v); return null; } catch (e) { return /** @type {Error} */ (e).message; } } },
  { key: 'expiryRouting', group: 'Routing', label: 'Expiry routing', type: 'json', apply: 'hot', def: { enabled: false, tolerance: 1.5, preempt: true },
    help: 'Prefer accounts whose weekly quota is ample and resets soonest (use-it-or-lose-it). Off keeps strict priority order.',
    check: (v) => (v == null || isObj(v) ? null : 'must be an object { enabled, tolerance, preempt }') },
  { key: 'routes', group: 'Routing', label: 'Model routes', type: 'json', apply: 'hot', def: [],
    help: 'Rules that send model patterns to specific accounts.',
    check: (v) => (Array.isArray(v) && v.every(isObj) ? null : 'must be an array of route objects') },

  // ── Keep-warm ───────────────────────────────────────────────────────────
  { key: 'warmOnExhaustion', group: 'Keep-warm', label: 'Align 5h windows', type: 'bool', apply: 'hot', def: false,
    help: 'When any account starts or uses up its 5h window, start every cold account\'s window too, so they refresh together.' },
  { key: 'warmupSeconds', group: 'Keep-warm', label: 'Warm-up interval (s)', type: 'int', apply: 'hot', def: 0, min: 0,
    help: 'Start idle accounts\' 5h windows this often. Spends a little quota. 0 = off.',
    check: (v) => (v > 0 && v < 60 ? 'must be 0 (off) or at least 60' : null) },
  { key: 'warmupSchedule', group: 'Keep-warm', label: 'Warm-up schedule', type: 'json', apply: 'hot', def: null,
    help: 'Time warm-ups for a daily reset, e.g. { "resetTime": "15:30", "timezone": "America/Los_Angeles" }. Empty = none.',
    check: (v) => { if (v == null) return null; try { resolveWarmupSchedule(v); return null; } catch (e) { return /** @type {Error} */ (e).message; } } },
  { key: 'warmTransport', group: 'Keep-warm', label: 'Warm-up transport', type: 'enum', apply: 'restart', def: 'direct', options: ['direct', 'claude'],
    help: 'How a warm-up is sent: direct (the proxy calls itself, reliable) or claude (spawns the CLI).' },

  // ── Proxy & access ──────────────────────────────────────────────────────
  { key: 'proxy.port', group: 'Proxy & access', label: 'Port', type: 'int', apply: 'restart', def: 3456, min: 1, max: 65535,
    help: 'Port the proxy listens on.' },
  { key: 'proxy.host', group: 'Proxy & access', label: 'Bind address', type: 'text', apply: 'restart', def: '127.0.0.1', danger: true,
    help: 'Interface to listen on. 127.0.0.1 = this host only; 0.0.0.0 = the network (then a proxy key is required). TEAMCLAUDE_HOST overrides it.' },
  { key: 'proxy.apiKey', group: 'Proxy & access', label: 'Proxy key (admin)', type: 'secret', apply: 'hot', def: null, danger: true,
    help: 'The shared key clients present. It also unlocks this Settings view. Write-only; cannot be cleared here.' },
  { key: 'proxy.clientKeys', group: 'Proxy & access', label: 'Client keys', type: 'secretList', apply: 'hot', def: [],
    help: 'Per-client keys ({ name, key }); usage is booked per name. Keys are write-only; a masked key means keep it.' },
  { key: 'proxy.trustLoopback', group: 'Proxy & access', label: 'Trust loopback', type: 'bool', apply: 'restart', def: true, danger: true,
    help: 'Let callers on this host skip the key. Turn off behind a reverse proxy on the same host.' },
  { key: 'proxy.usageDimensions', group: 'Proxy & access', label: 'Usage dimensions', type: 'json', apply: 'hot', def: [],
    help: 'Book token usage by request header, e.g. [{ "name": "project", "header": "x-teamclaude-project" }].',
    check: (v) => (Array.isArray(v) && v.every((d) => isObj(d) && typeof d.name === 'string' && typeof d.header === 'string') ? null : 'must be an array of { name, header }') },
  { key: 'proxy.sessionDetail', group: 'Proxy & access', label: 'Per-session detail', type: 'bool', apply: 'hot', def: false,
    help: 'Show one row per session (client, project, tokens) in status and on the dashboard.' },
  { key: 'proxy.maxBodyBytes', group: 'Proxy & access', label: 'Max request body (bytes)', type: 'int', apply: 'restart', def: 64 * 1024 * 1024, min: 0,
    help: 'Largest request body accepted. 0 = no limit.' },
  { key: 'proxy.tls', group: 'Proxy & access', label: 'TLS listener', type: 'json', apply: 'restart', def: null, danger: true,
    help: 'Second port that speaks TLS for off-box clients, e.g. { "port": 3443, "host": "0.0.0.0", "hosts": ["10.0.6.145"] }. Empty = off.',
    check: (v, cfg) => { try { resolveTlsConfig({ ...(cfg?.proxy || {}), tls: v }); return null; } catch (e) { return /** @type {Error} */ (e).message; } } },

  // ── Upstream & network ──────────────────────────────────────────────────
  { key: 'upstream', group: 'Upstream & network', label: 'Upstream API', type: 'text', credUrl: true, apply: 'restart', def: 'https://api.anthropic.com', danger: true,
    help: 'Where requests (and account tokens) are sent. Change only for a compatible backend.',
    check: (v) => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? null : 'must be an http(s) URL'; } catch { return 'must be a URL'; } } },
  { key: 'upstreamProxy', group: 'Upstream & network', label: 'Outbound proxy', type: 'text', credUrl: true, apply: 'restart', def: null, danger: true,
    help: 'Proxy for everything sent to Anthropic, e.g. http://host:3128. A password in it is write-only. false = never use one.',
    check: (v) => { if (v === false || v == null || v === '') return null; try { parseProxyUrl(String(v)); return null; } catch (e) { return /** @type {Error} */ (e).message; } } },
  { key: 'noProxy', group: 'Upstream & network', label: 'No-proxy hosts', type: 'list', apply: 'restart', def: [],
    help: 'Hosts that never go through a proxy; also merged into the client env `teamclaude env` prints.' },
  { key: 'mitm.http1Only', group: 'Upstream & network', label: 'HTTP/1.1 only (MITM)', type: 'bool', apply: 'restart', def: false,
    help: 'Offer only HTTP/1.1 on intercepted connections. Needed for Remote Control from the Desktop app.' },
  { key: "egress.pin", group: "Upstream & network", label: "Pinned exit IP", type: "json", apply: "restart", def: null, danger: true,
    help: "Hold requests while the public IP is not this one (a dropped VPN): \"auto\" pins the first address seen, or an IP or list of IPs. Empty = off.",
    check: (v) => (v == null || typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string")) ? null : "must be \"auto\", an IP, or a list of IPs") },
  { key: 'egress.checkUrl', group: 'Upstream & network', label: 'Exit-IP check URL', type: 'text', credUrl: true, apply: 'restart', def: 'https://api.ipify.org',
    help: 'Service that reports the current public IP.' },
  { key: 'egress.ttlSeconds', group: 'Upstream & network', label: 'Exit-IP recheck (s)', type: 'int', apply: 'restart', def: 30, min: 1,
    help: 'How long a confirmed exit IP is trusted before checking again.' },
  { key: 'egress.holdSeconds', group: 'Upstream & network', label: 'Exit-IP hold (s)', type: 'int', apply: 'restart', def: 120, min: 0,
    help: 'Longest a request waits for the pinned exit IP to come back.' },
  { key: 'autoUpdate', group: 'Upstream & network', label: 'Self-update', type: 'bool', apply: 'restart', def: true,
    help: 'Check npm for a newer teamclaude in the background.' },
  { key: 'sx.apiKey', group: 'Upstream & network', label: 'sx.org key', type: 'secret', apply: 'hot', def: null,
    help: 'Auto-provision a residential proxy (egress-IP 429 workaround). Write-only. Clear it to turn sx off.' },
  { key: 'sx.mode', group: 'Upstream & network', label: 'sx.org mode', type: 'enum', apply: 'hot', def: 'always', options: ['always', '429', 'off'],
    help: 'always = all traffic via sx; 429 = only after a 429; off = keep the key but don\'t use it.' },

  // ── Logging ─────────────────────────────────────────────────────────────
  { key: 'eventLogging', group: 'Logging', label: 'Telemetry events', type: 'enum', apply: 'hot', def: 'hide', options: ['hide', 'show', 'block'],
    help: 'Claude Code\'s telemetry: hide (forward, keep out of the activity log), show, or block (answer locally).' },
  { key: 'logDir', group: 'Logging', label: 'Request log directory', type: 'text', apply: 'restart', def: null, danger: true,
    help: 'Write one file per request here. Empty = no request logs.' },
  { key: 'logLevel', group: 'Logging', label: 'Request log detail', type: 'enum', apply: 'restart', def: 'body', options: ['body', 'headers', 'off'],
    help: 'What each request log keeps: bodies, headers only, or nothing.' },
  { key: 'logMaxBodyBytes', group: 'Logging', label: 'Log body cap (bytes)', type: 'int', apply: 'restart', def: 262144, min: 0,
    help: 'Largest body kept per direction in a request log. 0 = no cap.' },
  { key: 'logRetentionHours', group: 'Logging', label: 'Log retention (h)', type: 'number', apply: 'restart', def: 72, min: 0,
    help: 'Delete request logs older than this. 0 = keep forever.' },
  { key: 'sessionTitles', group: 'Logging', label: 'Session titles (TUI)', type: 'json', apply: 'hot', def: { enabled: false, width: 18 },
    help: 'Name TUI activity rows after the Claude Code session. Interactive TUI only.',
    check: (v) => (v == null || isObj(v) ? null : 'must be an object { enabled, width, projectsDir }') },

  // ── Dashboard service ───────────────────────────────────────────────────
  { key: 'service.logs', group: 'Dashboard service', label: 'Logs panel source', type: 'json', apply: 'restart', def: 'journald',
    help: 'Where the Logs panel reads: "journald", { "file": "/path" }, or false.',
    check: (v) => { const r = /** @type {any} */ (resolveLogSource({ service: { logs: v } })); return v === false || r.kind !== 'off' ? null : r.reason; } },
  { key: 'service.restart', group: 'Dashboard service', label: 'Restart button', type: 'json', apply: 'restart', def: 'systemd', danger: true,
    help: 'How Restart works: "systemd", "exit" (a supervisor restarts it), { "command": [argv] }, or false.',
    check: (v) => { const r = /** @type {any} */ (resolveRestartMethod({ service: { restart: v } })); return v === false || r.kind !== 'off' ? null : r.reason; } },
];

/** Per-account fields the Settings view edits. Tokens and identity are not here. */
/** @type {Field[]} */
export const ACCOUNT_FIELDS = [
  { key: 'priority', label: 'Priority', type: 'int', apply: 'hot', def: 0, min: 0, help: 'Lower = used first. The list order sets this.' },
  { key: 'disabled', label: 'Disabled', type: 'bool', apply: 'hot', def: false, help: 'Keep this account out of rotation.' },
  { key: 'maxUsage', label: 'Usage cap', type: 'json', apply: 'hot', def: null, help: 'Hard cap: a number, or a per-bucket table. Empty = none.', check: (v) => (v == null ? null : thresholdCheck(v)) },
  { key: 'upstream', label: 'Account upstream', type: 'text', credUrl: true, apply: 'hot', def: null, danger: true, help: 'Alternative backend URL for this account only. Empty = the global upstream.' },
  { key: 'modelMap', label: 'Model map', type: 'json', apply: 'hot', def: null, help: 'Rename models for this account\'s backend. Empty = none.', check: (v) => (v == null || isObj(v) ? null : 'must be an object') },
  { key: 'stripRequestFields', label: 'Strip request fields', type: 'list', apply: 'restart', def: [], help: 'Top-level request fields dropped before sending to this account; "cache_control.<subfield>" drops that subfield.' },
];

/** Identity fields shown read-only (set from the OAuth profile). */
export const ACCOUNT_READONLY = ['accountUuid', 'orgUuid', 'orgName'];

/** Deprecated per-account fields: kept working, not offered for editing. */
export const ACCOUNT_DEPRECATED = ['models'];

export const ORDER_HELP = 'Requests always go to the highest account with quota left; when a higher one renews, traffic moves back to it.';

// ── paths ────────────────────────────────────────────────────────────────
/** @param {any} obj @param {string} path */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
/** @param {any} obj @param {string} path @param {any} value */
function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
  const last = /** @type {string} */ (parts.at(-1));
  if (value === undefined) delete o[last]; else o[last] = value;
}

/** A field as sent to the browser: everything but its validator. @param {Field} f */
const withoutCheck = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'check'));

// ── masking ──────────────────────────────────────────────────────────────
// Credentials inside a URL-valued setting ("scheme://user:pass@host", a bare
// "user:pass@host:3128", a token-only "http://tok@host"). Found the way the
// WHATWG URL parser — and so parseProxyUrl — finds them: the authority runs to
// the first / ? # or \\, and its userinfo to the LAST "@" inside it, so an
// unencoded "@" in a password is still all userinfo. With no "@" in the
// authority but one later (a value the parser would reject), everything up to
// the last "@" counts: over-masking a broken value is the safe direction. The
// whole userinfo is replaced, username included — a token-only form has no
// password part, and the username is the credential.
/** @param {any} v @returns {{ head: string, userinfo: string, tail: string } | null} */
function splitUserinfo(v) {
  if (typeof v !== "string") return null;
  const start = (v.match(/^\s*[a-z0-9+.-]+:\/\//i) || v.match(/^\s*/))?.[0].length ?? 0;
  const rest = v.slice(start);
  const end = rest.search(/[/?#\\]/);
  let at = (end < 0 ? rest : rest.slice(0, end)).lastIndexOf("@");
  if (at < 0) at = rest.lastIndexOf("@");
  if (at < 0) return null;
  return { head: v.slice(0, start), userinfo: rest.slice(0, at), tail: rest.slice(at) };
}
/** @param {any} v */
function maskUrlCredentials(v) {
  const p = splitUserinfo(v);
  return p ? p.head + MASK + p.tail : v;
}
/** @param {Field} f @param {any} v */
function displayValue(f, v) {
  if (f.type === 'secret') return v ? MASK : null;
  if (f.type === 'secretList') return Array.isArray(v) ? v.map((e) => ({ name: e?.name ?? '', key: e?.key ? MASK : '' })) : [];
  if (f.credUrl) return maskUrlCredentials(v);
  return v;
}

/**
 * What GET /teamclaude/settings returns: every field with its current value
 * (secrets masked), default and metadata, plus the editable account fields.
 * @param {any} config
 */
export function publicSettings(config) {
  const fields = FIELDS.map((f) => {
    const raw = getPath(config, f.key);
    const meta = withoutCheck(f);
    return { ...meta, value: displayValue(f, raw), set: raw !== undefined && raw !== null && raw !== '' };
  });
  const accounts = (config?.accounts || []).map((/** @type {any} */ a, /** @type {number} */ i) => ({
    id: a.id ?? null, name: a.name, index: i, type: a.type,
    ...Object.fromEntries(ACCOUNT_FIELDS.map((f) => [f.key, displayValue(f, a[f.key] ?? f.def)])),
    readonly: Object.fromEntries(ACCOUNT_READONLY.map((k) => [k, a[k] ?? null])),
  }));
  // Keys in the file that no version of this schema reads (a typo, or a
  // setting from an older release) — shown so nothing in the file is invisible.
  const known = new Set(FIELDS.map((f) => f.key));
  const tops = new Set([...known].map((k) => k.split(".")[0]).concat("accounts"));
  const unknown = Object.keys(config || {}).filter((k) => !tops.has(k));
  for (const parent of ["proxy", "egress", "sx", "service", "mitm"]) {
    for (const k of Object.keys(isObj(config?.[parent]) ? config[parent] : {})) if (!known.has(`${parent}.${k}`)) unknown.push(`${parent}.${k}`);
  }
  return {
    fields,
    unknown,
    accountFields: ACCOUNT_FIELDS.map(withoutCheck),
    accounts,
    orderHelp: ORDER_HELP,
    mask: MASK,
  };
}

/**
 * A URL setting sent back with its masked userinfo: put the stored userinfo
 * back. MASK anywhere other than the whole userinfo is refused, so the stored
 * credentials can only return to the position they were shown in.
 * @param {string} v @param {any} stored
 */
function restoreUrlCredentials(v, stored) {
  const p = splitUserinfo(v);
  if (!p || p.userinfo !== MASK || p.head.includes(MASK) || p.tail.includes(MASK)) return { problem: "retype the credentials (the masked value can only stand for the whole user:password part)" };
  const old = splitUserinfo(stored);
  if (!old) return { problem: "no stored credentials to keep; type them" };
  return { value: p.head + old.userinfo + p.tail };
}

// ── validation ───────────────────────────────────────────────────────────
/** @param {Field|any} f @param {any} v @param {any} cfg @returns {string|null} */
function problemFor(f, v, cfg) {
  if (v === null) return null; // null = unset: the default applies
  switch (f.type) {
    case 'bool': if (typeof v !== 'boolean') return 'must be true or false'; break;
    case 'int': if (!Number.isInteger(v)) return 'must be a whole number'; break;
    case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a number'; break;
    case 'enum': if (!(f.options || []).some((/** @type {any} */ o) => o === v)) return `must be one of ${(f.options || []).map((/** @type {any} */ o) => JSON.stringify(o)).join(', ')}`; break;
    case 'text': if (typeof v !== 'string' && v !== false) return 'must be text'; break;
    case 'list': if (!(Array.isArray(v) && v.every((s) => typeof s === 'string')) && typeof v !== 'string') return 'must be a list of text'; break;
    case 'secret': if (typeof v !== 'string') return 'must be text'; break;
    case 'secretList': if (!Array.isArray(v) || !v.every((e) => isObj(e) && typeof e.name === 'string' && e.name.trim() && typeof e.key === 'string' && e.key)) return 'must be a list of { name, key }'; break;
    default: break;
  }
  if ((f.type === 'int' || f.type === 'number') && f.min != null && v < f.min) return `must be at least ${f.min}`;
  if ((f.type === 'int' || f.type === 'number') && f.max != null && v > f.max) return `must be at most ${f.max}`;
  return f.check ? f.check(v, cfg) : null;
}

/** Thrown with every problem a save had, so the UI can show them all at once. */
export class SettingsError extends Error {
  /** @param {string[]} problems */
  constructor(problems) { super(problems.join('; ')); this.problems = problems; }
}

/**
 * Validate `changes` against the schema and apply them to `config` (mutated).
 * Nothing is written unless every change is valid.
 *
 * changes = { set: { "<key>": value, … }, accounts: [{ id, <field>: value }], order: [id, …] }
 * A value of null unsets the key (the default applies). MASK on a secret keeps it.
 * @param {any} config
 * @param {{ set?: Record<string, any>, accounts?: any[], order?: any[] }} changes
 * @returns {{ applied: string[], needsRestart: string[] }}
 */
export function applySettingsChanges(config, changes) {
  const problems = [];
  const plan = [];
  const byKey = new Map(FIELDS.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(changes?.set || {})) {
    const f = byKey.get(key);
    if (!f) { problems.push(`${key}: not a setting`); continue; }
    let v = raw;
    if (f.type === 'secret') {
      if (v === MASK) continue;                        // unchanged
      if (key === 'proxy.apiKey' && (v == null || v === '')) { problems.push('proxy.apiKey: cannot be cleared from the dashboard (it would open the proxy to anyone)'); continue; }
      if (v === '') v = null;
    }
    if (f.type === 'secretList' && Array.isArray(v)) {
      const old = new Map((getPath(config, key) || []).map((/** @type {any} */ e) => [e?.name, e?.key]));
      v = v.map((/** @type {any} */ e) => (isObj(e) && e.key === MASK ? { ...e, key: old.get(e.name) } : e));
      const lost = v.filter((/** @type {any} */ e) => isObj(e) && !e.key).map((/** @type {any} */ e) => e.name);
      if (lost.length) { problems.push(`${key}: no stored key for ${lost.join(', ')}; type a key`); continue; }
    }
    if (f.credUrl && typeof v === "string" && v.includes(MASK)) {
      const r = restoreUrlCredentials(v, getPath(config, key));
      if (r.problem) { problems.push(`${key}: ${r.problem}`); continue; }
      v = r.value;
    }
    if (f.type === 'list' && typeof v === 'string') v = v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (f.type === 'text' && v === '') v = null;
    if (JSON.stringify(v ?? null) === JSON.stringify(getPath(config, key) ?? null)) continue; // unchanged
    const p = problemFor(f, v, config);
    if (p) problems.push(`${key}: ${p}`);
    else plan.push([f, v]);
  }

  const accounts = config?.accounts || [];
  const findAcct = (/** @type {any} */ id) => accounts.find((/** @type {any} */ a) => a.id === id);
  const acctPlan = [];
  for (const ch of changes?.accounts || []) {
    const a = findAcct(ch?.id);
    if (!a) { problems.push(`account ${ch?.id}: not found`); continue; }
    for (const [k, raw] of Object.entries(ch)) {
      if (k === 'id') continue;
      const f = ACCOUNT_FIELDS.find((x) => x.key === k);
      if (!f) { problems.push(`account ${a.name}: ${k} is not an editable field`); continue; }
      let v = raw;
      if (f.credUrl && typeof v === 'string' && v.includes(MASK)) {
        const r = restoreUrlCredentials(v, a[k]);
        if (r.problem) { problems.push(`account ${a.name}: ${k} ${r.problem}`); continue; }
        v = r.value;
      }
      if (f.type === 'list' && typeof v === 'string') v = v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (f.type === 'text' && v === '') v = null;
      if (JSON.stringify(v ?? null) === JSON.stringify(a[k] ?? null)) continue;
      const p = problemFor(f, v, config);
      if (p) problems.push(`account ${a.name}: ${k} ${p}`); else acctPlan.push([a, f, v]);
    }
  }
  let order = null;
  if (changes?.order) {
    const ids = changes.order;
    const known = new Set(accounts.map((/** @type {any} */ a) => a.id));
    if (!Array.isArray(ids) || ids.length !== accounts.length || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
      problems.push('order: must list every account exactly once');
    } else order = ids;
  }
  if (problems.length) throw new SettingsError(problems);

  const applied = new Set(); const needsRestart = new Set();
  for (const [f, v] of plan) {
    setPath(config, f.key, v === null ? undefined : v);
    (f.apply === 'hot' ? applied : needsRestart).add(f.key);
  }
  for (const [a, f, v] of acctPlan) {
    if (v === null) delete a[f.key]; else a[f.key] = v;
    (f.apply === 'hot' ? applied : needsRestart).add(`accounts.${f.key}`);
  }
  if (order) {
    // Priority = list position, so strict order is exactly the list.
    order.forEach((id, i) => { findAcct(id).priority = i; });
    applied.add('accounts.priority');
  }
  return { applied: [...applied], needsRestart: [...needsRestart] };
}

// ── backups ──────────────────────────────────────────────────────────────
export const BACKUP_KEEP = 20;
/**
 * Copy the config to <config>.bak-settings-<timestamp> (0600: it holds OAuth
 * tokens) and prune all but the newest `keep`. Called inside the config lock,
 * after validation and before the write, so each backup is the version the
 * save replaced. Returns the backup's file name.
 * @param {string} configPath @param {number} [keep] @param {Date} [now]
 */
export async function backupConfig(configPath, keep = BACKUP_KEEP, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const prefix = `${basename(configPath)}.bak-settings-`;
  let name = prefix + stamp;
  const dir = dirname(configPath);
  const existing = (await readdir(dir)).filter((f) => f.startsWith(prefix));
  for (let n = 2; existing.includes(name); n++) name = `${prefix}${stamp}-${n}`;
  const dest = join(dir, name);
  await copyFile(configPath, dest);
  await chmod(dest, 0o600);
  const all = [...existing, name].sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) await unlink(join(dir, old)).catch(() => {});
  return name;
}

/**
 * The whole save: validate and apply under the config lock, back up the
 * version being replaced (only once validation passed, so a refused save
 * leaves no backup and no write), write, then run `reload` so hot keys apply.
 * @param {any} changes @param {() => Promise<any>} [reload]
 */
export async function saveSettings(changes, reload) {
  /** @type {{ applied: string[], needsRestart: string[] }} */
  let result = { applied: [], needsRestart: [] };
  /** @type {string|undefined} */
  let backup;
  await atomicConfigUpdate(async (/** @type {any} */ diskConfig) => {
    result = applySettingsChanges(diskConfig, changes);
    if (!result.applied.length && !result.needsRestart.length) return;
    backup = await backupConfig(getConfigPath());
  });
  if (backup) await reload?.();
  return { ...result, backup: backup ?? null };
}
