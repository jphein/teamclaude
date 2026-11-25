// CHECK forge-models (docs/CHECKS.md): the Forge lists every model the fleet can reach, and every listed
// model answers. Nightly. JP 2026-11-17 05:03 (via Sen): "Make sure the forge has comprehensive of all
// available models I notice some missing": the page listed 14 rows (2 dead) of 64 reachable.
//
// Listed = the gateway registry (`forge route show`), the host feed's stems and forge-direct.json (Claude
// seats, Azure Speech, Foundry media, other local). Reachable is read from each provider's own catalog:
// the seat picker (through the proxy), Foundry's deployments (Entra token from the cached az login: no
// API key), Nebius /v1/models (vault, only when already unlocked), running model units and containers,
// katana's ollama tags.
//   fail: a reachable model is unlisted; a listed one did not answer or was not probed; a registered or
//         direct Foundry deployment now serves another model (drift: the gateway's allowlist is by name)
//   warn: a source could not be read (named), or a desktop host is asleep
// Order matters (xreview #89 r1.1): Foundry's deployments are read BEFORE any gateway probe, and a Foundry
// route is probed only when its deployment serves exactly the expected first-party model, so a deployment
// re-pointed at Claude (Marketplace billing) is never called. Claude probes run with a scrubbed
// environment through the seat proxy only, and the proxy's own per-client counter must rise by one per
// probe (proof they went through the seats).
// Only fixed words reach the CHECK line and direct.json (r1.2): never a provider's or a tool's text.
//
// Inputs (tests): CHECK_FM_INPUTS=<json> replaces collect(); CHECK_FM_URLS=<json> points the HTTP reads at
// a test server; CHECK_FM_PLAN (the plan data dir), CHECK_FM_OUT, CHECK_FM_NOW_MS, CHECK_FM_CONFIG,
// CHECK_FM_PACE_MS (probe spacing), CHECK_FM_HOME.
import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { inflateSync, crc32 } from 'node:zlib';
import { join, dirname, sep } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.CHECK_FM_HOME || homedir();
const CFG = JSON.parse(readFileSync(process.env.CHECK_FM_CONFIG || join(HERE, 'forge-direct.json'), 'utf8'));
const PLAN = process.env.CHECK_FM_PLAN || join(HOME, 'srv/plan.realm.watch/data/forge');
const URLS = { foundryApi: null, nebius: 'https://api.tokenfactory.nebius.com/v1/models', tts: null, stt: null, katana: 'http://katana:11434/api/tags',
  status: 'http://127.0.0.1:3456/teamclaude/status', ...(process.env.CHECK_FM_URLS ? JSON.parse(process.env.CHECK_FM_URLS) : {}) };
const PACE = Number(process.env.CHECK_FM_PACE_MS ?? 3500);
const FEED_STALE_MS = 15 * 60_000;
const MODEL_UNIT = /(llama|ollama|wyoming|piper|whisper|vllm|sglang|embed|kokoro|parakeet|wakeword|scribe|qwen|donkey|tts|asr)/i;
const NOT_A_MODEL = /^(teamclaude-|realm-|forge-|palace|mempalace)/;
const CLAUDE_RE = /claude|anthropic/i;
// the only words a probe error may carry onto the line or the page
const GATEWAY_ERRORS = new Set(['auth', 'rate_limited', 'not_found', 'bad_request', 'upstream', 'timeout_or_unreachable', 'probe key missing',
  'gateway registry unreadable', 'not registered', 'gateway host unreachable']);
const REGION = /^[a-z]{2,16}[0-9]?$/;
// A provider-supplied id reaches the line or the page only when it looks like a model id: plain
// segments, no run of 20+ letters/digits (a key shape), no credential words (xreview #89 r2.3).
export function safeId(s) {
  const v = String(s ?? '');
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(v) && !/[A-Za-z0-9+]{20,}/.test(v) && !/(bearer|sk-|key|token|secret|password)/i.test(v) ? v : '(unrecognized id)';
}

// A registry row's disabled_reason for the line. An ALLOWLIST of what a reason looks like (xreview
// #102 round 2, comment 7148792741: a denylist of secret shapes always has a next bypass). Anything
// that does not look like a plain sentence prints "reason not shown":
//   * letters, digits, spaces and , . ( ) - _ only, 1 to 120 characters (so no / : ? = @: no URL, no
//     host path, no query, no email, no base64 padding);
//   * no whitespace-separated token over 20 characters that mixes letters and digits;
//   * no key prefix (sk- pk- ghp_ xoxb- AKIA eyJ), whatever follows it;
//   * none of password, passwd, secret, token, key, bearer followed by another token.
// Stricter still, kept from safeName (security review of 4bd7ce7): no 16+ word between separators
// that mixes letters and digits, no 24+ alphanumeric run (which covers a 32+ hex run).
const REASON_CHARS = /^[A-Za-z0-9 ,.()_-]{1,120}$/;
const REASON_PREFIX = /(^|[^A-Za-z0-9])(sk-|pk-|ghp_|xoxb-|AKIA|eyJ)/i;
const REASON_SECRET_WORD = /(^|[^A-Za-z0-9])(password|passwd|secret|token|key|bearer)\s+\S/i;
const mixesLettersDigits = (/** @type {string} */ w) => /[0-9]/.test(w) && /[A-Za-z]/.test(w);
export function safeReason(s) {
  const v = String(s ?? '').trim();
  const plain = REASON_CHARS.test(v) && !REASON_PREFIX.test(v) && !REASON_SECRET_WORD.test(v)
    && !v.split(/\s+/).some((t) => t.length > 20 && mixesLettersDigits(t))
    && !v.split(/[ ,.()_-]+/).some((w) => w.length >= 16 && mixesLettersDigits(w))
    && !/[A-Za-z0-9]{24,}/.test(v);   // (a 32+ hex run is one of these, so it needs no rule of its own)
  return plain ? v : 'reason not shown';
}

// a vault item name for the line and the page: names are written by people, so only plain ones pass
// (r1.5) Not a guarantee against a secret typed into a name, but a credential's usual shapes are refused: a long
// run, a known key prefix, or a 16+ character word mixing letters and digits.
export function safeName(s) {
  const v = String(s ?? '').trim();
  if (!/^[A-Za-z0-9 ._:()\/@,'-]{1,90}$/.test(v) || /[A-Za-z0-9+]{24,}/.test(v)) return '(unrecognized name)';
  if (/(^|[^A-Za-z0-9])(sk|pk|rk|nvapi|gsk|hf|r8|fal|xai|ghp|gho|ghs|glpat|xox[abpr]|AIza)[-_]?[A-Za-z0-9]{8,}/i.test(v)) return '(unrecognized name)';
  if (v.split(/[ ._:()\/@,'-]+/).some((w) => w.length >= 16 && /[0-9]/.test(w) && /[A-Za-z]/.test(w))) return '(unrecognized name)';
  return v;
}
// (r1.4, r2.2) vendorScan patterns are a restricted language: literals, classes, anchors and alternation, with NO
// quantifier at all (+ * { ?), so the matcher has no loop: alternation can still multiply paths, but only up to a
// fixed bound set by the 40-character cap, per position of a 200-character name. Each must compile on its own; a bad
// one makes the whole config "bad", never a hang or a crash.
export function scanPatterns(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const p of list) {
    if (typeof p !== 'string' || !/^[A-Za-z0-9 ._^$()|\[\]\\-]{1,40}$/.test(p) || /\\[^bB.\-()]/.test(p)) return null;
    try { out.push(new RegExp(p, 'i')); } catch { return null; }
  }
  return out;
}
const VENDOR_ERRORS = /^(http [0-9]{1,3}|bad answer|no answer|key not read|bad probe spec|vault locked|no entra token|accepts a bad key)$/;
// a vendor probe from the repo's config: https only, a plain header name, a known scheme, a fixed shape to expect
export function vendorSpec(p) {
  let u;
  try { u = new URL(p?.url); } catch { return null; }
  const testHttp = !!process.env.CHECK_FM_URLS && u.protocol === 'http:' && u.hostname === '127.0.0.1';   // the tests' local server only
  if ((u.protocol !== 'https:' && !testHttp) || u.username || u.password) return null;
  if (!/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(p.header || '') || !['', 'Bearer ', 'Key '].includes(p.scheme ?? '')) return null;
  if (!/^(array|[a-z_]{1,20})$/.test(p.expect || '')) return null;
  if (p.body !== undefined && (typeof p.body !== 'object' || p.body === null)) return null;
  // an Entra token reaches every Cognitive Services resource of the login, so it goes to one of those only, as a bearer
  const auth = p.auth ?? 'vault';
  if (!['vault', 'entra'].includes(auth)) return null;
  if (auth === 'entra' && (!(u.hostname.endsWith('.cognitiveservices.azure.com') || testHttp) || p.header !== 'Authorization' || p.scheme !== 'Bearer ')) return null;
  return { url: u.href, header: p.header, scheme: p.scheme ?? '', expect: p.expect, allowEmpty: p.allowEmpty === true, body: p.body, auth };
}
async function vendorProbe(spec, key) {
  const h = { [spec.header]: spec.scheme + key, 'User-Agent': 'forge-models', Accept: 'application/json' };
  if (spec.body) h['Content-Type'] = 'application/json';
  const r = await get(spec.url, h, 30_000, spec.body ? 'POST' : 'GET', spec.body ? JSON.stringify(spec.body) : undefined);
  if (r.status === 0) return { ok: false, error: 'no answer' };
  if (r.status !== 200) return { ok: false, error: `http ${r.status}` };
  const d = json(r.body.toString());
  const x = spec.expect === 'array' ? d : d?.[spec.expect];
  const shaped = Array.isArray(x) && (spec.allowEmpty || x.length > 0);   // every configured shape is an array (r1.3)
  return { ok: shaped, error: shaped ? null : 'bad answer' };
}
// (r1.3, r2.1) the instrument proves itself each night: the same request with a WELL-FORMED WRONG credential (the
// real one, its last characters shifted within their class) must be refused as unauthenticated (401/403), or a 200
// below could come from an endpoint that answers any key of the right shape. It goes only where the real key goes,
// and a refusal happens before any work, so it costs nothing. Measured 2026-11-17: all eight vendors 401/403.
export function wrongKey(k) {
  const n = Math.min(8, Math.floor(k.length / 2));
  const shift = (c) => /[0-9]/.test(c) ? String((+c + 1) % 10) : /[a-z]/.test(c) ? String.fromCharCode((c.charCodeAt(0) - 97 + 1) % 26 + 97)
    : /[A-Z]/.test(c) ? String.fromCharCode((c.charCodeAt(0) - 65 + 1) % 26 + 65) : c;
  return k.slice(0, k.length - n) + [...k.slice(k.length - n)].map(shift).join('');
}
// 'refused' (the instrument is proven), 'no answer' (nothing came back: a reset or timeout proves nothing either
// way, 2026-11-17 11:59 Azure reset TLS mid-run and the row read "accepts a bad key"), or 'accepted' (any status
// but 401/403, a 400 for a malformed key included: format checking is not authentication, r2.1)
async function wrongKeyVerdict(spec, key) {
  const bad = wrongKey(key);
  if (bad === key) return 'accepted';   // nothing to shift: no control, so no proof
  const h = { [spec.header]: spec.scheme + bad, 'User-Agent': 'forge-models', Accept: 'application/json' };
  if (spec.body) h['Content-Type'] = 'application/json';
  const send = () => get(spec.url, h, 30_000, spec.body ? 'POST' : 'GET', spec.body ? JSON.stringify(spec.body) : undefined);
  let r = await send();
  if (r.status === 0 && !spec.body) { await sleep(PACE); r = await send(); }   // a GET control gets the probe's one retry; a POST never
  return r.status === 401 || r.status === 403 ? 'refused' : r.status === 0 ? 'no answer' : 'accepted';
}
// one probe: the control first, then the real key; a GET (free, read only) gets one retry, a POST never (r1.2)
async function probeVendor(spec, key) {
  const control = await wrongKeyVerdict(spec, key);
  if (control === 'no answer') return { ok: false, error: 'no answer' };
  if (control !== 'refused') return { ok: false, error: 'accepts a bad key' };
  let res = await vendorProbe(spec, key);
  if (!res.ok && !spec.body) { await sleep(PACE); res = await vendorProbe(spec, key); }
  return res;
}
const hostOf = (uri) => { try { return new URL(/^[a-z]+:\/\//i.test(uri) ? uri : `https://${uri}`).hostname.toLowerCase(); } catch { return ''; } };

// a child's environment: no proxy, no alternate Claude provider, no API key from the caller's shell,
// and nothing a calling Claude session or interactive shell lends it (CLAUDE_*, the CA trust), so a
// run by hand sees what the timer sees (2026-11-17: a hand run passed on the shell's CA, the timer failed)
function scrubbed() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)) continue;
    if (/^(ANTHROPIC_|CLAUDE_|AWS_|AZURE_|VERTEX_|CLOUD_ML_|GOOGLE_)/.test(k)) continue;
    if (/^(NODE_|SSL_CERT_)/.test(k)) continue;   // CA trust, NODE_TLS_REJECT_UNAUTHORIZED, --require hooks (r1.1)
    e[k] = v;
  }
  return e;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 << 20, env: scrubbed(), input: '', ...opts });
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
async function get(url, headers = {}, ms = 20_000, method = 'GET', body) {
  try {
    const r = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  } catch { return { status: 0, body: Buffer.alloc(0) }; }
}
// The vault is read only when it is ALREADY unlocked, and bw is told never to prompt (r1.3).
function vaultUnlocked() {
  const r = run('bw', ['status', '--nointeraction'], { timeout: 90_000, env: { ...scrubbed(), BW_NOINTERACTION: 'true' } });
  return r.status === 0 && json(r.stdout)?.status === 'unlocked';
}
function vault(item) {
  const r = run('bw', ['get', 'password', item, '--nointeraction'], { timeout: 90_000, env: { ...scrubbed(), BW_NOINTERACTION: 'true' } });   // bw can take ~30 s
  const v = (r.stdout || '').trim();
  return r.status === 0 && v && !/\s/.test(v) ? v : null;
}
// the check's own seat client key: a 0600 settings file whose proxy is the local forwarder (r1.7)
function seatSettings() {
  const f = join(HOME, '.config/teamclaude-client/forge-check.settings.json');
  try {
    const st = statSync(f);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    const p = json(readFileSync(f, 'utf8'))?.env?.HTTPS_PROXY || '';
    return /^http:\/\/(tc-[0-9a-f]{48}):\1@127\.0\.0\.1:3456$/.test(p) ? f : null;
  } catch { return null; }
}
// the MITM CA the seat proxy presents: Claude Code trusts it only through NODE_EXTRA_CA_CERTS. It
// becomes a trust root for the child, so only a file this account owns and nobody else can replace (r1.2)
const SEAT_CA = join(HOME, '.config/teamclaude-ca.pem');
function seatCa() {
  const mine = (st) => st.uid === process.getuid() && (st.mode & 0o022) === 0;
  try {
    const d = lstatSync(dirname(SEAT_CA)), f = lstatSync(SEAT_CA);
    return d.isDirectory() && mine(d) && f.isFile() && mine(f) && f.size > 0 ? SEAT_CA : null;
  } catch { return null; }
}
const SEAT_SETUP = new Set(['seat client key missing', 'seat CA missing']);
function seatCount() {   // forge-check's request counter at the proxy (null when unreadable)
  const r = run('curl', ['-q', '-s', '-f', '--noproxy', '*', '--max-time', '15', URLS.status], { timeout: 30_000 });
  const n = json(r.stdout)?.clients?.['forge-check']?.requests;
  return r.status === 0 && Number.isInteger(n) ? n : null;
}

// ---------- reads (each returns null when its source can't be read)
/**
 * The gateway registry as `forge route show --json` printed it, normalized for judge(), or null when
 * unreadable. Pure, so the collection boundary (the raw `disabled_reason` field) is tested directly
 * (xreview #102 round 1).
 * @param {number|null} status the command's exit status @param {any} reg its parsed stdout
 */
export function registryRows(status, reg) {
  if (status !== 0 || !reg?.ok || !Array.isArray(reg.models)) return null;
  // Every row an object with a string name before any property is read; one malformed row makes the
  // whole registry unreadable (null), never a partial list (xreview #102 round 2).
  if (!reg.models.every((/** @type {any} */ m) => m !== null && typeof m === 'object' && !Array.isArray(m) && typeof m.name === 'string')) return null;
  return reg.models.map((/** @type {any} */ m) => ({ name: String(m.name), provider: String(m.provider), enabled: !!m.enabled, mode: m.mode || 'chat',
    upstream: String(m.upstream || ''), disabledReason: typeof m.disabled_reason === 'string' ? m.disabled_reason.trim() : '' }));
}

export async function collect() {
  const inp = {};
  // 1. Foundry deployments FIRST (r1.1): what each deployment serves decides whether it may be probed
  const conf = existsSync(join(HOME, '.config/xreview/foundry.conf')) ? readFileSync(join(HOME, '.config/xreview/foundry.conf'), 'utf8') : '';
  const ep = (conf.match(/^FOUNDRY_ENDPOINT=(.+)$/m)?.[1] || '').replace(/["'\s]/g, '').replace(/\/$/, '');
  const api = URLS.foundryApi || (/^https:\/\/[a-z0-9-]+\.cognitiveservices\.azure\.com$/.test(ep) ? `${ep}/openai/deployments?api-version=2022-12-01` : null);
  const tok = api ? run('az', ['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--query', 'accessToken', '-o', 'tsv'], { timeout: 60_000 }).stdout?.trim() : '';
  inp.foundry = null;
  if (api && tok && /^[A-Za-z0-9._-]{20,8192}$/.test(tok)) {
    const r = await get(api, { Authorization: `Bearer ${tok}` });
    const d = r.status === 200 ? json(r.body.toString()) : null;
    if (Array.isArray(d?.data) && d.data.every((x) => typeof x?.id === 'string')) inp.foundry = d.data.map((x) => ({ id: x.id, model: String(x.model || ''), status: String(x.status || '') }));
  }
  inp.foundryProbes = {};
  for (const f of CFG.foundryDirect) {   // the direct media deployments answer one small call each (r2.4)
    const d = (inp.foundry || []).find((x) => x.id === f.deployment);
    if (!d || d.status !== 'succeeded' || CLAUDE_RE.test(`${d.id} ${d.model}`) || CFG.foundryExpect[d.id] !== d.model) continue;
    const base = URLS.foundryBase || api.replace(/\/openai\/deployments\?.*$/, '');
    const h = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
    const r = f.kind === 'image'
      ? await get(`${base}/openai/v1/images/generations`, h, 120_000, 'POST', JSON.stringify({ model: f.deployment, prompt: 'a small iron anvil, flat icon', size: '1024x1024', quality: 'low', n: 1 }))
      : await get(`${base}/openai/deployments/${encodeURIComponent(f.deployment)}/chat/completions?api-version=2025-01-01-preview`, h, 60_000, 'POST',
        JSON.stringify({ modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'wav' }, messages: [{ role: 'user', content: 'Say ok.' }], max_completion_tokens: 100 }));
    const b = r.status === 200 ? json(r.body.toString()) : null;
    // a real answer, not just the shape (r3.2): an image of some size; a WAV that decodes, with audio in it
    const audio = f.kind === 'image' ? null : Buffer.from(String(b?.choices?.[0]?.message?.audio?.data || ''), 'base64');
    const ok = f.kind === 'image' ? typeof b?.data?.[0]?.b64_json === 'string' && isImage(Buffer.from(b.data[0].b64_json, 'base64'))
      : playableWav(audio);
    inp.foundryProbes[f.deployment] = { ok, error: ok ? null : r.status === 200 ? 'bad answer' : `http ${r.status}` };
  }
  const safeAzure = new Set((inp.foundry || []).filter((d) => d.status === 'succeeded' && !CLAUDE_RE.test(`${d.id} ${d.model}`) && CFG.foundryExpect[d.id] === d.model).map((d) => `azure/${d.id}`));
  // 2. the gateway registry, then one probe per enabled model (a Foundry route only when safe, above)
  const show = run('forge', ['route', 'show', '--json'], { timeout: 60_000 });
  const reg = json(show.stdout);
  inp.registry = registryRows(show.status, reg);
  inp.gatewayProbes = {};
  for (const m of (inp.registry || []).filter((x) => x.enabled)) {
    if (m.provider === 'azure' && !safeAzure.has(m.upstream)) { inp.gatewayProbes[m.name] = { ok: false, error: 'not probed: deployment unverified' }; continue; }
    if (CLAUDE_RE.test(`${m.name} ${m.upstream}`)) { inp.gatewayProbes[m.name] = { ok: false, error: 'not probed: claude' }; continue; }
    let p = null;
    for (let i = 0; i < 2 && !p?.ok; i++) {   // one retry: a single upstream error is not a dead model
      if (i) await sleep(PACE * 3);
      p = json(run('forge', ['probe', m.name, '--who', 'forge-models', '--json'], { timeout: 90_000 }).stdout);
      await sleep(PACE);   // the forge-probe key allows 20 requests a minute
    }
    inp.gatewayProbes[m.name] = { ok: !!p?.ok, error: p?.ok ? null : (GATEWAY_ERRORS.has(p?.error) ? p.error : 'no answer') };
  }
  // 3. the host feed
  inp.feed = {};
  for (const stem of Object.keys(CFG.feedStems)) {
    const f = join(PLAN, 'hosts', `${stem}.json`);
    const d = existsSync(f) ? json(readFileSync(f, 'utf8')) : null;
    inp.feed[stem] = d && typeof d.state === 'string' && typeof d.ts === 'string' ? { state: d.state, ts: d.ts } : null;
  }
  // 4. Claude seats: the picker through the proxy, then one probe each with the check's own client key
  const pick = run('curl', ['-q', '-s', '-f', '--max-time', '30', '-x', 'http://127.0.0.1:3456', '--noproxy', '', '--cacert', join(HOME, '.config/teamclaude-ca.pem'),
    '-H', 'Authorization: Bearer placeholder', '-H', 'anthropic-beta: oauth-2025-04-20', 'https://api.anthropic.com/api/model_selector/code'], { timeout: 60_000 });
  const pj = json(pick.stdout);
  inp.claudeCatalog = pick.status === 0 && Array.isArray(pj?.model_selector_config) ? pj.model_selector_config.flatMap((c) => (Array.isArray(c?.models) ? c.models : []).map((m) => String(m?.id))) : null;
  inp.claudeProbes = {};
  const settings = seatSettings(), ca = seatCa();
  for (const c of CFG.claude) {
    if (!settings || !ca) { inp.claudeProbes[c.id] = { ok: false, served: [], seen: false, error: settings ? 'seat CA missing' : 'seat client key missing' }; continue; }
    let d = null, seen = false;
    for (let i = 0; i < 2 && !(d && !d.is_error); i++) {   // one retry, as for the gateway
      if (i) await sleep(PACE * 3);
      // each invocation must itself show at the proxy under forge-check (r1.1/r2.1): a counter that
      // does not move across THIS call means this call went somewhere else
      const before = seatCount();
      d = json(run('claude', ['-p', '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
        '--model', c.id, '--system-prompt', 'Answer with one word.', '--tools', '', '--output-format', 'json', 'Say ok.'], { timeout: 120_000, cwd: HOME, env: { ...scrubbed(), NODE_EXTRA_CA_CERTS: ca } }).stdout);
      const after = seatCount();
      seen = before !== null && after !== null && after > before;
    }
    const served = Object.keys(d?.modelUsage || {}).filter((k) => /^[a-z0-9.-]{1,60}$/.test(k));
    inp.claudeProbes[c.id] = { ok: !!d && !d.is_error, served, seen, error: d ? (d.is_error ? 'error' : null) : 'no answer' };
  }
  // 5. Nebius and Azure Speech, from the vault only when it is already unlocked
  const unlocked = vaultUnlocked();
  inp.nebius = null;
  const nk = unlocked ? vault(CFG.vault.nebius) : null;
  if (nk) {
    const r = await get(URLS.nebius, { Authorization: `Bearer ${nk}` });
    const d = r.status === 200 ? json(r.body.toString()) : null;
    if (Array.isArray(d?.data) && d.data.every((m) => typeof m?.id === 'string')) inp.nebius = d.data.map((m) => m.id);
  }
  inp.speech = null;
  const sk = unlocked ? vault(CFG.vault.speech) : null;
  const { tts, stt } = CFG.speechRegions || {};
  if (sk && REGION.test(tts || '') && REGION.test(stt || '')) {   // a region is a hostname label, never a host (r1.2)
    inp.speech = {};
    let wav = null;
    for (const s of CFG.speech.filter((x) => x.kind === 'tts')) {
      const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='${s.id.replace(/[^A-Za-z0-9:-]/g, '')}'>The forge is lit.</voice></speak>`;
      const r = await get(URLS.tts || `https://${tts}.tts.speech.microsoft.com/cognitiveservices/v1`, { 'Ocp-Apim-Subscription-Key': sk, 'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'riff-16khz-16bit-mono-pcm', 'User-Agent': 'forge-models' }, 30_000, 'POST', ssml);
      const okTts = r.status === 200 && playableWav(r.body);   // the PCM WAV that was asked for, not any 200 body (r6.2)
      inp.speech[s.id] = { ok: okTts, error: okTts ? null : r.status === 200 ? 'bad answer' : `http ${r.status}` };
      if (inp.speech[s.id].ok && !wav) wav = r.body;
    }
    for (const s of CFG.speech.filter((x) => x.kind === 'asr')) {
      if (!wav) { inp.speech[s.id] = { ok: false, error: 'no audio to transcribe' }; continue; }
      const r = await get(URLS.stt || `https://${stt}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`,
        { 'Ocp-Apim-Subscription-Key': sk, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000' }, 30_000, 'POST', wav);
      const d = r.status === 200 ? json(r.body.toString()) : null;
      inp.speech[s.id] = { ok: d?.RecognitionStatus === 'Success' && /forge/i.test(String(d?.DisplayText || '')), error: r.status === 200 ? (d ? null : 'bad answer') : `http ${r.status}` };
    }
  }
  // 7. AI vendors (JP 07:43, plan-chat 2414: "The forge is missing assembly ai?"): the vault's item NAMES
  // (only items holding a password; nothing else is kept), then one free authenticated call per vendor key
  inp.vaultItems = null;
  if (unlocked) {
    const r = run('bw', ['list', 'items', '--nointeraction'], { timeout: 120_000, maxBuffer: 64 << 20, env: { ...scrubbed(), BW_NOINTERACTION: 'true' } });
    const all = r.status === 0 ? json(r.stdout) : null;
    if (Array.isArray(all)) inp.vaultItems = all.filter((i) => i?.type === 1 && typeof i?.login?.password === 'string' && i.login.password.length > 0)
      .map((i) => ({ name: String(i.name ?? '').trim(), hosts: (Array.isArray(i.login.uris) ? i.login.uris : []).map((u) => hostOf(String(u?.uri ?? ''))).filter(Boolean) }));
  }
  inp.vendorProbes = {};
  let entraTok = tok && /^[A-Za-z0-9._-]{20,8192}$/.test(tok) ? tok : undefined;
  const entra = () => {
    if (entraTok === undefined) {
      const t = run('az', ['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--query', 'accessToken', '-o', 'tsv'], { timeout: 60_000 }).stdout?.trim() || '';
      entraTok = /^[A-Za-z0-9._-]{20,8192}$/.test(t) ? t : null;
    }
    return entraTok;
  };
  for (const v of CFG.vendors || []) {
    if (!v.probe) continue;
    const spec = vendorSpec(v.probe);
    if (!spec) { inp.vendorProbes[v.id] = { ok: false, error: 'bad probe spec' }; continue; }
    if (spec.auth === 'entra') {
      const t = entra();
      inp.vendorProbes[v.id] = t ? await probeVendor(spec, t) : { ok: false, error: 'no entra token' };
      continue;
    }
    if (!unlocked) { inp.vendorProbes[v.id] = { ok: false, error: 'vault locked' }; continue; }
    const k = vault(v.vault);
    if (!k) { inp.vendorProbes[v.id] = { ok: false, error: 'key not read' }; continue; }
    inp.vendorProbes[v.id] = await probeVendor(spec, k);
  }
  // 6. local: every scope must be read, or the unit list is unread (r1.5)
  const scopes = [run('systemctl', ['--user', 'list-units', '--type=service', '--state=running', '--no-legend', '--plain'], { timeout: 30_000 }),
    run('systemctl', ['list-units', '--type=service', '--state=running', '--no-legend', '--plain'], { timeout: 30_000 })];
  const dk = run('docker', ['ps', '--format', '{{.Names}}'], { timeout: 30_000 });
  inp.units = scopes.every((r) => r.status === 0) && dk.status === 0
    ? [...scopes.flatMap((r) => r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).map((u) => u.replace(/\.service$/, ''))), ...dk.stdout.split('\n').filter(Boolean)]
    : null;
  const kt = await get(URLS.katana, {}, 5_000);
  const kj = kt.status === 200 ? json(kt.body.toString()) : null;
  inp.katanaTags = Array.isArray(kj?.models) && kj.models.every((m) => typeof m?.name === 'string') ? kj.models.map((m) => m.name) : null;
  const health = CFG.local.find((l) => l.health)?.health;
  inp.embedHealth = health ? (await get(health, {}, 5_000)).status === 200 : false;
  inp.wake = await describe(CFG.local.find((l) => l.wyoming)?.wyoming);
  return inp;
}
// An image (r6.2/r7.1/r8.2): gpt-image answers a truecolour PNG, so only one that decodes counts: the
// signature, every chunk inside the file with a correct CRC, IHDR first (16–8192 px, RGB/RGBA at 8 or 16
// bits, no compression/filter/interlace variants), no unknown critical chunk, PLTE (optional) before
// consecutive IDATs that inflate to exactly height × (1 + row bytes), an empty IEND last.
export function isImage(b) {
  try {
    if (!Buffer.isBuffer(b) || b.length < 57 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
    let off = 8, ihdr = null, idat = [], ended = false, idatDone = false, plte = false;
    while (off + 12 <= b.length) {
      const len = b.readUInt32BE(off), type = b.toString('latin1', off + 4, off + 8), end = off + 12 + len;
      if (len > b.length || end > b.length) return false;
      if (crc32(b.subarray(off + 4, off + 8 + len)) !== b.readUInt32BE(off + 8 + len)) return false;
      const d = b.subarray(off + 8, off + 8 + len);
      if (!ihdr && type !== 'IHDR') return false;
      const critical = type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
      if (type === 'IHDR') {
        if (ihdr || len !== 13) return false;
        ihdr = { w: d.readUInt32BE(0), h: d.readUInt32BE(4), depth: d[8], color: d[9], comp: d[10], filter: d[11], lace: d[12] };
      } else if (type === 'IDAT') {
        if (idatDone) return false;   // IDAT chunks are consecutive
        idat.push(d);
      } else if (type === 'IEND') { ended = len === 0 && end === b.length; break; }
      else if (type === 'PLTE') {   // optional for truecolour: once, before the data, 1–256 RGB entries (r9.2)
        if (idat.length || plte || len % 3 !== 0 || len < 3 || len > 768) return false;
        plte = true;
      }
      else if (critical) return false;   // an unknown critical chunk: a decoder must refuse it (r8.2)
      if (type !== 'IDAT' && idat.length) idatDone = true;
      off = end;
    }
    if (!ihdr || !ended || !idat.length) return false;
    const { w, h, depth, color, comp, filter, lace } = ihdr;
    // gpt-image answers truecolour (RGB or RGBA); indexed and grey PNGs are not its answer (r8.2)
    const legal = { 2: [8, 16], 6: [8, 16] };
    if (w < 16 || h < 16 || w > 8192 || h > 8192 || !legal[color]?.includes(depth) || comp !== 0 || filter !== 0 || lace !== 0) return false;
    const channels = { 2: 3, 6: 4 }[color];
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: 256 << 20 });
    const row = Math.ceil((w * channels * depth) / 8);
    if (raw.length !== h * (1 + row)) return false;
    for (let y = 0; y < h; y++) if (raw[y * (1 + row)] > 4) return false;   // each row's filter type is 0–4
    return true;
  } catch { return false; }
}

// A WAV that a player would play (r4.1/r5): RIFF/WAVE whose declared size fits the buffer, a consistent PCM
// `fmt ` chunk (1–2 channels, 8–48 kHz, 8/16/24-bit) and a whole-block `data` chunk of at least 0.1 s, all
// inside the declared container.
export function playableWav(b) {
  if (!Buffer.isBuffer(b) || b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return false;
  const riff = b.readUInt32LE(4);
  // A streaming writer (gpt-audio-mini, measured 2026-11-17) declares the RIFF and data sizes as
  // 0xFFFFFFFF, "unknown": then the container is the file. Any other size must fit (r5.1).
  const STREAM = 0xffffffff;
  if (riff !== STREAM && (riff < 36 || riff + 8 > b.length)) return false;
  const end = riff === STREAM ? b.length : riff + 8;   // chunks live inside the declared RIFF container
  let fmt = null, off = 12;
  while (off + 8 <= end) {
    const id = b.toString('latin1', off, off + 4), body = off + 8;
    let size = b.readUInt32LE(off + 4);
    const streamedData = id === 'data' && size === STREAM && riff === STREAM;
    if (streamedData) size = end - body;   // streamed: the rest of the file
    if (body + size > end) return false;
    if (id === 'fmt ') {
      if (size < 16) return false;
      fmt = { tag: b.readUInt16LE(body), ch: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), byteRate: b.readUInt32LE(body + 8),
        align: b.readUInt16LE(body + 12), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt || fmt.tag !== 1 || fmt.ch < 1 || fmt.ch > 2 || fmt.rate < 8000 || fmt.rate > 48000 || ![8, 16, 24].includes(fmt.bits)) return false;
      // PCM consistency (r5.2): a block is one sample per channel, and the byte rate follows from it
      if (fmt.align !== fmt.ch * (fmt.bits / 8) || fmt.byteRate !== fmt.rate * fmt.align) return false;
      return (streamedData || size % fmt.align === 0) && size >= fmt.byteRate / 10;   // only a streamed data chunk may end mid-block (r8.3)
    }
    off = body + size + (size & 1);
  }
  return false;
}

function describe(port) {   // Wyoming describe → the wake word names, or null
  return new Promise((res) => {
    if (!port) return res(null);
    let done = false;
    // an absolute deadline and a size cap (r6.1): a peer trickling bytes resets an idle timeout forever
    const deadline = setTimeout(() => settle(null), 10_000);
    const settle = (v) => { if (!done) { done = true; clearTimeout(deadline); s.destroy(); res(v); } };
    const s = connect({ host: '127.0.0.1', port }, () => s.write('{"type": "describe"}\n'));
    let buf = '';
    s.setTimeout(5000, () => settle(null));
    s.on('error', () => settle(null));
    s.on('end', () => settle(null));     // an early EOF or a truncated answer is no answer (r4.2)
    s.on('close', () => settle(null));
    s.on('data', (d) => {
      buf += d;
      if (buf.length > 256 * 1024) return settle(null);
      const nl = buf.indexOf('\n'); if (nl < 0) return;
      const hdr = json(buf.slice(0, nl)); const need = hdr?.data_length || 0;
      if (buf.length - nl - 1 < need) return;
      // every nested entry is checked, and nothing here can throw out of the socket callback (r7.2)
      try {
        const data = need ? json(buf.slice(nl + 1, nl + 1 + need)) : hdr?.data;
        const wake = data?.wake;
        const ok = Array.isArray(wake) && wake.every((p) => p && typeof p === 'object' && Array.isArray(p.models)
          && p.models.every((m) => m && typeof m === 'object' && typeof m.name === 'string'));
        settle(ok ? wake.flatMap((p) => p.models.map((m) => m.name)) : null);
      } catch { settle(null); }
    });
  });
}

// ---------- the verdict (pure)
export function judge(cfg, inp, nowMs) {
  const unlisted = [], unreachable = [], drift = [], unread = [], asleep = [];
  const blocked = { foundry_claude: 0, foundry_third_party: 0 };
  const thirdParty = new Set(Object.values(cfg.foundryBlockedModels || {}).flat());
  const reg = inp.registry;
  if (!reg) unread.push('gateway registry');
  const enabled = (reg || []).filter((m) => m.enabled);
  const upstreams = new Set(enabled.map((m) => m.upstream).filter(Boolean));
  // A registry row enabled:false with a disabled_reason states why its upstream stays unlisted (row
  // 1d742c98, ubox0-93 2026-11-24): it is accounted for, the line warns and quotes the reason. A
  // disabled row with no reason accounts for nothing: its upstream stays unlisted (fail).
  const disabledWhy = new Map((reg || []).filter((m) => !m.enabled && m.upstream && String(m.disabledReason ?? '').trim())
    .map((m) => [m.upstream, String(m.disabledReason).trim()]));
  const accounted = [];
  /** @param {string} upstream @param {string} label @returns {boolean} the upstream is listed or accounted for */
  const coveredOrAccounted = (upstream, label) => {
    if (upstreams.has(upstream)) return true;
    const why = disabledWhy.get(upstream);
    if (why == null) return false;
    accounted.push(`${label} (${safeReason(why)})`);
    return true;
  };
  const asleepStems = new Set();
  for (const [stem, gw] of Object.entries(cfg.feedStems)) {
    const f = inp.feed?.[stem];
    const t = Date.parse(f?.ts || '');
    if (!f || !Number.isFinite(t) || nowMs - t > FEED_STALE_MS) { unread.push(`host feed ${stem}`); continue; }
    if (f.state === 'asleep') { asleep.push(stem); if (gw) asleepStems.add(gw); }
    else if (f.state === 'down' && !gw) unreachable.push(`${stem} (down)`);   // an LLM stem is judged by its gateway probe
  }
  for (const m of enabled) {
    const p = inp.gatewayProbes?.[m.name];
    if (p?.ok) continue;
    if (asleepStems.has(m.name)) continue;   // a desktop asleep: warn above, not unreachable
    unreachable.push(`${safeId(m.name)} (${p ? (GATEWAY_ERRORS.has(p.error) || /^not probed: /.test(p.error || '') ? p.error : 'no answer') : 'not probed'})`);
  }
  // Claude seats: listed and probed, in the catalog, served as itself, and seen at the proxy
  const cl = new Set(cfg.claude.map((c) => c.id));
  const inCatalog = (id) => !!inp.claudeCatalog?.includes(id);
  if (!inp.claudeCatalog) unread.push('seat model catalog');
  else {
    for (const id of new Set(inp.claudeCatalog)) if (!cl.has(id)) unlisted.push(`claude:${safeId(id)}`);
    for (const id of cl) if (!inCatalog(id)) unreachable.push(`${id} (left the seat catalog)`);
  }
  // affirmative proof only (r2.2): a probe counts when it answered, as itself, and was seen at the proxy
  const claudeOk = (id) => { const p = inp.claudeProbes?.[id]; return !!p?.ok && p.served.includes(id) && p.seen === true && (!inp.claudeCatalog || inCatalog(id)); };
  for (const c of cfg.claude) {
    const p = inp.claudeProbes?.[c.id];
    if (!p) unreachable.push(`${c.id} (not probed)`);
    else if (!p.ok) unreachable.push(`${c.id} (${SEAT_SETUP.has(p.error) ? p.error : 'error'})`);
    else if (!p.served.includes(c.id)) unreachable.push(`${c.id} (served as ${p.served.map(safeId).join('+') || 'nothing'})`);
    else if (p.seen !== true) unreachable.push(`${c.id} (not seen at the seat proxy)`);
  }
  // Foundry: coverage by the model each deployment actually serves (r1.6)
  const fd = new Map((inp.foundry || []).map((d) => [d.id, d]));
  const direct = new Set(cfg.foundryDirect.map((d) => d.deployment));
  const mine = [...[...upstreams].filter((u) => u.startsWith('azure/')).map((u) => u.slice(6)), ...direct];
  if (!inp.foundry) unread.push('Foundry deployments');
  else {
    const listedModels = new Set(mine.map((id) => cfg.foundryExpect[id]).filter(Boolean));
    for (const d of inp.foundry) {
      if (d.status !== 'succeeded') continue;   // a failed deployment (sora-2) serves nothing
      if (CLAUDE_RE.test(`${d.id} ${d.model}`)) { if (!mine.includes(d.id)) blocked.foundry_claude++; continue; }
      if (thirdParty.has(d.model)) { if (!mine.includes(d.id)) blocked.foundry_third_party++; continue; }
      if (mine.includes(d.id)) continue;   // judged below
      if (!listedModels.has(d.model) && !coveredOrAccounted(`azure/${d.id}`, `foundry:${safeId(d.id)}`)) unlisted.push(`foundry:${safeId(d.id)} (${safeId(d.model)})`);
    }
    for (const id of mine) {
      const d = fd.get(id);
      if (!d || d.status !== 'succeeded') { unreachable.push(`foundry:${safeId(id)} (deployment ${d ? (d.status === 'failed' ? 'failed' : 'not ready') : 'gone'})`); continue; }
      if (d.model !== cfg.foundryExpect[id] || CLAUDE_RE.test(d.model)) drift.push(`foundry:${safeId(id)} now serves ${safeId(d.model)}`);
      else if (direct.has(id) && !inp.foundryProbes?.[id]?.ok) unreachable.push(`foundry:${safeId(id)} (${/^(http [0-9]{1,3}|bad answer)$/.test(inp.foundryProbes?.[id]?.error || '') ? inp.foundryProbes[id].error : 'not probed'})`);
    }
  }
  if (!inp.nebius) unread.push('Nebius catalog (vault locked?)');
  else for (const id of new Set(inp.nebius)) if (!coveredOrAccounted(`nebius/${id}`, `nebius:${safeId(id)}`)) unlisted.push(`nebius:${safeId(id)}`);
  if (!inp.speech) unread.push('Azure Speech (vault locked?)');
  else for (const s of cfg.speech) if (!inp.speech[s.id]?.ok) unreachable.push(`${s.id} (${/^(http [0-9]{1,3}|no audio to transcribe|bad answer)$/.test(inp.speech[s.id]?.error || '') ? inp.speech[s.id].error : 'no answer'})`);
  if (!inp.units) unread.push('running units');
  else for (const u of new Set(inp.units)) if (MODEL_UNIT.test(u) && !NOT_A_MODEL.test(u) && !(u in cfg.localUnits)) unlisted.push(`unit:${safeId(u)}`);
  if (inp.katanaTags) { for (const t of inp.katanaTags) if (!(t in cfg.katanaTags)) unlisted.push(`katana:${safeId(t)}`); }
  else if (!asleep.includes('katana')) unread.push('katana tags');
  const localOk = { embedding: inp.embedHealth === true, wake: Array.isArray(inp.wake) && inp.wake.length > 0 };
  for (const l of cfg.local) if (!localOk[l.kind]) unreachable.push(`${l.id} (no answer)`);

  // AI vendors: every vault item an AI-vendor pattern matches is listed or accounted for, and every listed key answers
  const vendors = cfg.vendors || [], scan = cfg.vendorScan || {};
  const accountedNames = new Set([...vendors.map((v) => v.vault).filter(Boolean), cfg.vault?.nebius, cfg.vault?.speech, ...Object.values(scan.accountedNames || {}).flat()]
    .filter(Boolean).map((n) => String(n).trim()));
  const aiList = scanPatterns(scan.patterns || []), accountedRx = scanPatterns(Object.keys(scan.accountedPatterns || {}));
  const badScan = !aiList || !accountedRx;
  if (badScan) unlisted.push('config: a vendorScan pattern is not allowed (no quantifier, at most 40 characters)');
  const aiRx = !badScan && aiList.length ? { test: (t) => aiList.some((r) => r.test(String(t).slice(0, 200))) } : null;
  const vaultMatched = new Map();   // accounted-pattern reason -> count, for the page
  if (vendors.length || aiRx) {
    if (!inp.vaultItems) unread.push('vault item list (vault locked?)');
    else if (aiRx) for (const name of new Set(inp.vaultItems.filter((i) => aiRx.test(i.name) || i.hosts.some((h) => aiRx.test(h))).map((i) => i.name))) {
      if (accountedNames.has(name)) continue;
      const hit = Object.keys(scan.accountedPatterns || {}).find((p, j) => accountedRx[j].test(name.slice(0, 200)));
      if (hit) { const why = scan.accountedPatterns[hit]; vaultMatched.set(why, (vaultMatched.get(why) || 0) + 1); continue; }
      unlisted.push(`vault:${safeName(name)}`);
    }
  }
  const vendorErr = (v) => { const p = inp.vendorProbes?.[v.id]; return !p ? 'not probed' : VENDOR_ERRORS.test(p.error || '') ? p.error : 'no answer'; };
  for (const v of vendors) {
    if (!v.probe || inp.vendorProbes?.[v.id]?.ok) continue;
    if (inp.vendorProbes?.[v.id]?.error === 'vault locked') { if (!unread.includes('vendor keys (vault locked?)')) unread.push('vendor keys (vault locked?)'); continue; }
    unreachable.push(`${safeId(v.id)} (${vendorErr(v)})`);
  }

  const nGateway = enabled.length, nFeed = Object.values(cfg.feedStems).filter((g) => !g).length;
  const nDirect = cfg.claude.length + cfg.speech.length + cfg.foundryDirect.length + cfg.local.length;
  const state = unlisted.length || unreachable.length || drift.length ? 'fail' : unread.length || asleep.length || accounted.length ? 'warn' : 'ok';
  const few = (a) => a.slice(0, 6).join(', ') + (a.length > 6 ? ` +${a.length - 6} more` : '');
  let fact = `${nGateway + nFeed + nDirect} listed (${nGateway} gateway, ${nFeed} host-feed voices, ${nDirect} direct)`;
  if (vendors.length) fact += `; ${vendors.length} vendor keys (${vendors.filter((v) => v.probe).length} probed)`;
  fact += unreachable.length ? `; didn't answer: ${few(unreachable)}` : unread.length || asleep.length ? '; none of the models probed failed' : '; every listed model answered';
  if (unlisted.length) fact += `; reachable but unlisted: ${few(unlisted)}`;
  // Every one, never "+N more": each entry is a standing decision, and its id and reason must stay in
  // sight (xreview #102 round 1).
  if (accounted.length) fact += `; unlisted on purpose: ${accounted.join(', ')}`;
  if (drift.length) fact += `; deployment drift: ${few(drift)}`;
  if (asleep.length) fact += `; asleep: ${asleep.join(', ')}`;
  if (unread.length) fact += `; not read: ${few(unread)}`;
  fact += `; blocked on Foundry: ${blocked.foundry_claude} Claude, ${blocked.foundry_third_party} third-party`;

  // the page's rows: the same conditions as the verdict, fixed words only
  const at = new Date(nowMs).toISOString();
  const row = (o, ok, error, instrument) => ({ ...o, reachable: !!ok, checked: at, instrument, error: ok ? null : error });
  const claudeErr = (id) => { const p = inp.claudeProbes?.[id];
    return !p ? 'not probed' : SEAT_SETUP.has(p.error) ? p.error : !p.ok ? 'error' : !p.served.includes(id) ? 'served as another model'
      : p.seen !== true ? 'not seen at the seat proxy' : inp.claudeCatalog && !inCatalog(id) ? 'left the seat catalog' : 'error'; };
  const vendorRows = vendors.map((v) => {
    const o = { name: v.id, label: v.label, route: 'vendor', provider: v.provider, kind: v.modality?.[0], modality: v.modality, tier: v.tier, policy: v.policy,
      ...(v.vault ? { vault: safeName(v.vault) } : { auth: v.probe?.auth || 'none' }), ...(v.note ? { note: v.note } : {}) };
    return v.probe ? row(o, inp.vendorProbes?.[v.id]?.ok, vendorErr(v), v.instrument)
      : { ...o, reachable: null, checked: at, instrument: 'none', error: `not probed: ${v.why || 'no free call known'}` };
  });
  const rows = [
    ...vendorRows,
    ...cfg.claude.map((c) => row({ name: c.id, label: c.label, route: 'teamclaude', kind: 'llm', group: c.group, tier: 'seat', policy: 'claude-teamclaude-only' }, claudeOk(c.id), claudeErr(c.id), 'claude -p through the seats')),
    ...cfg.speech.map((s) => row({ name: s.id, label: s.label, route: 'azure-speech', kind: s.kind, tier: 'credit', policy: s.policy }, inp.speech?.[s.id]?.ok,
      !inp.speech ? 'not read' : /^(http [0-9]{1,3}|no audio to transcribe|bad answer)$/.test(inp.speech[s.id]?.error || '') ? inp.speech[s.id].error : 'no answer',
      s.kind === 'tts' ? 'one sentence synthesized' : 'the synthesized sentence transcribed')),
    ...cfg.foundryDirect.map((f) => { const d = fd.get(f.deployment); const fp = inp.foundryProbes?.[f.deployment];
      const okDep = d?.status === 'succeeded' && d.model === cfg.foundryExpect[f.deployment] && !CLAUDE_RE.test(d.model);
      return row({ name: f.deployment, label: f.label, route: 'foundry-direct', kind: f.kind, tier: 'credit', policy: 'foundry-first-party' }, okDep && fp?.ok === true,
        !inp.foundry ? 'not read' : !d ? 'deployment gone' : d.status !== 'succeeded' ? 'deployment not ready' : !okDep ? 'deployment serves another model'
          : /^(http [0-9]{1,3}|bad answer)$/.test(fp?.error || '') ? fp.error : 'not probed', f.kind === 'image' ? 'one low-quality image' : 'one short spoken answer'); }),
    ...cfg.local.map((l) => row({ name: l.id, label: l.label, route: 'local', kind: l.kind, host: l.host, tier: 'local', policy: 'local' }, localOk[l.kind], 'no answer', l.health ? 'health endpoint' : 'wyoming describe')),
  ];
  return { state, fact, unlisted, accounted, unreachable, drift, unread, asleep, blocked,
    direct: { schema: 'forge.direct/v1', ts: at, poller: 'teamclaude-check-forge-models', models: rows, blocked,
      ...(vendors.length || aiRx ? { vendorsWithoutKey: (cfg.vendorsWithoutKey || []).map((x) => ({ vendor: safeName(x.vendor), status: String(x.status ?? '').slice(0, 120) })),
        vaultAccounted: [...Object.entries(scan.accountedNames || {}).map(([why, names]) => ({ why, names: names.map(safeName) })),
          ...[...vaultMatched].map(([why, count]) => ({ why, count }))] } : {}) } };
}

// Publish into the plan's data dir (r1.4): every directory from HOME down is a real directory owned by
// this user and not group/world-writable (no symlink anywhere on the path), the same directory before
// and after the write; the file is created exclusively (O_EXCL never follows) and renamed over the
// target (rename replaces a symlink, never its target). HOME is held to the same rule (r2.5).
// Threat model: every directory checked is this user's and writable by no one else, so only this
// uid could swap one between the check and the rename, and that uid already owns the file outright;
// Node has no openat(), so a descriptor-anchored publish is not available here.
// this user's primary group when it is provably private, else null (fail closed, r8.1): resolved through NSS
// (getent), the group lists no member but this user, and no other account has it as its primary group.
function privateGroup() {
  try {
    const gid = process.getgid(), user = userInfo().username;   // from the passwd entry, not the environment
    // enumeration proves exclusivity only when every account is local (r9.1): NSS passwd and group
    // must come from files (and systemd's own users) alone; LDAP/SSSD/NIS may hide accounts from it
    const nss = readFileSync(process.env.CHECK_FM_NSSWITCH || '/etc/nsswitch.conf', 'utf8');
    for (const db of ['passwd', 'group']) {
      const srcs = (nss.match(new RegExp(`^${db}:\\s*(.*)$`, 'm'))?.[1] || '').replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).filter(Boolean);
      if (!srcs.length || srcs.some((x) => x !== 'files' && x !== 'systemd')) return null;
    }
    const g = run('getent', ['group'], { timeout: 30_000 });
    const pw = run('getent', ['passwd'], { timeout: 30_000 });
    if (g.status !== 0 || pw.status !== 0) return null;
    // EVERY group entry with this gid (a duplicate gid line is a second group): each must be this
    // user's own, with no member but this user
    const same = g.stdout.split('\n').filter(Boolean).map((l) => l.split(':')).filter((f) => f[2] === String(gid));
    if (!same.length || same.some(([name, , , members = '']) => name !== user || !(members === '' || members === user))) return null;
    const rows = pw.stdout.split('\n').filter(Boolean).map((l) => l.split(':'));
    if (!rows.some((f) => f[0] === user)) return null;   // a listing without this user is not the full list
    return rows.some((f) => f[3] === String(gid) && f[0] !== user) ? null : gid;
  } catch { return null; }
}

export function publish(doc, out, home = HOME) {
  const dir = dirname(out);
  if (!dir.startsWith(home + sep)) throw Object.assign(new Error('outside home'), { code: 'EPATH' });
  const chain = [];
  for (let p = dir; p.length >= home.length; p = dirname(p)) { chain.push(p); if (p === home) break; }
  const uid = process.getuid();
  const solo = privateGroup();
  const ids = chain.map((p) => {
    const st = lstatSync(p);
    // group write is allowed only for this user's own private group (no other members): Ubuntu's
    // user-private-group umask makes ~/srv 775, and nobody else is in that group (r2.5 kept for others)
    const groupOk = !(st.mode & 0o020) || (solo !== null && st.gid === solo);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || (st.mode & 0o002) || !groupOk) throw Object.assign(new Error('unsafe path'), { code: 'EPATH' });
    return `${st.dev}:${st.ino}`;
  });
  const tmp = join(dir, `.direct.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n', { mode: 0o640, flag: 'wx' });
  const st = lstatSync(dir);
  if (`${st.dev}:${st.ino}` !== ids[0] || st.isSymbolicLink()) { rmSync(tmp, { force: true }); throw Object.assign(new Error('dir changed'), { code: 'EPATH' }); }
  renameSync(tmp, out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = Number(process.env.CHECK_FM_NOW_MS) || Date.now();
  let inp;
  try { inp = process.env.CHECK_FM_INPUTS ? JSON.parse(readFileSync(process.env.CHECK_FM_INPUTS, 'utf8')) : await collect(); }
  catch (e) { process.stdout.write(`fail\tcheck crashed reading its sources (${e instanceof SyntaxError ? 'SyntaxError' : 'error'})\n`); process.exit(0); }
  const v = judge(CFG, inp, now);
  const out = process.env.CHECK_FM_OUT || join(PLAN, 'direct.json');
  let fact = v.fact;
  let state = v.state;
  // the page goes stale without this file: at least a warn, never ok (r3.3)
  try { publish(v.direct, out); } catch (e) { fact += `; direct.json not written (${['EPATH', 'ENOENT', 'EACCES', 'EEXIST'].includes(e?.code) ? e.code : 'error'})`; if (state === 'ok') state = 'warn'; }
  process.stdout.write(`${state}\t${fact.replace(/[\t\n\r]/g, ' ')}\n`);
}
