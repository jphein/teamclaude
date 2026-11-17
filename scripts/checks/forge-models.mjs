// CHECK forge-models (docs/CHECKS.md): the Forge lists every model the fleet can reach, and every listed
// model answers. Nightly. JP 2026-11-17 05:03 (via Sen): "Make sure the forge has comprehensive of all
// available models I notice some missing" — the page listed 14 rows (2 dead) of 64 reachable.
//
// Listed = the gateway registry (`forge route show`), the host feed's stems and forge-direct.json (Claude
// seats, Azure Speech, Foundry media, other local). Reachable is read from each provider's own catalog:
// the seat picker (through the proxy), Foundry's deployments (Entra token from the cached az login: no
// API key), Nebius /v1/models (vault, only when unlocked), running model units and containers, katana's
// ollama tags.
//   fail: a reachable model is unlisted; a listed one did not answer; a registered or direct Foundry
//         deployment now serves another model (drift: the gateway's allowlist is by deployment name)
//   warn: a source could not be read (named), or a desktop host is asleep
// Writes the direct rows (with last night's result) to the plan's data/forge/direct.json (forge.direct/v1).
// Prints one tab-separated record for forge-models.sh: state, fact.
//
// Inputs (tests): CHECK_FM_INPUTS=<json> replaces every read and probe; CHECK_FM_OUT, CHECK_FM_NOW_MS.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CFG = JSON.parse(readFileSync(process.env.CHECK_FM_CONFIG || join(HERE, 'forge-direct.json'), 'utf8'));
const PLAN = join(HOME, 'srv/plan.realm.watch/data/forge');
const NOPROXY = { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '', ALL_PROXY: '' };
const FEED_STALE_MS = 15 * 60_000;
const MODEL_UNIT = /(llama|ollama|wyoming|piper|whisper|vllm|sglang|embed|kokoro|parakeet|wakeword|scribe|qwen|donkey|tts|asr)/i;
const NOT_A_MODEL = /^(teamclaude-|realm-|forge-|palace|mempalace)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 << 20, ...opts });
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
async function get(url, headers = {}, ms = 20_000, method = 'GET', body) {
  try {
    const r = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  } catch (e) { return { status: 0, error: e?.name || 'error' }; }
}
function vault(item) {   // non-interactive: a locked vault is "not read", never a prompt
  const r = run('bw', ['get', 'password', item], { timeout: 90_000, input: '' });   // bw can take ~30 s (measured 27.7 s)
  const v = (r.stdout || '').trim();
  return r.status === 0 && v && !/\s/.test(v) ? v : null;
}

// ---------- reads (each returns null when its source can't be read)
async function collect() {
  const inp = {};
  const show = run('forge', ['route', 'show', '--json'], { timeout: 60_000 });
  const reg = json(show.stdout);
  inp.registry = show.status === 0 && reg?.ok && Array.isArray(reg.models) ? reg.models.map((m) => ({ name: m.name, provider: m.provider, enabled: !!m.enabled, mode: m.mode || 'chat', upstream: m.upstream || '' })) : null;
  inp.gatewayProbes = {};
  for (const m of (inp.registry || []).filter((x) => x.enabled)) {
    let p = null;
    for (let i = 0; i < 2 && !p?.ok; i++) {   // one retry: a single upstream error is not a dead model
      if (i) await sleep(10_000);
      p = json(run('forge', ['probe', m.name, '--who', 'forge-models', '--json'], { timeout: 90_000 }).stdout);
      await sleep(3500);   // the forge-probe key allows 20 requests a minute
    }
    inp.gatewayProbes[m.name] = { ok: !!p?.ok, error: p?.ok ? null : String(p?.error || 'no answer').slice(0, 40) };
  }
  inp.feed = {};
  for (const stem of Object.keys(CFG.feedStems)) {
    const d = json(existsSync(join(PLAN, 'hosts', `${stem}.json`)) ? readFileSync(join(PLAN, 'hosts', `${stem}.json`), 'utf8') : 'null');
    inp.feed[stem] = d ? { state: d.state, ts: d.ts } : null;
  }
  // the seat catalog, through the proxy (it substitutes a seat's token for the placeholder)
  const pick = run('curl', ['-q', '-s', '-f', '--max-time', '30', '-x', 'http://127.0.0.1:3456', '--noproxy', '', '--cacert', join(HOME, '.config/teamclaude-ca.pem'),
    '-H', 'Authorization: Bearer placeholder', '-H', 'anthropic-beta: oauth-2025-04-20', 'https://api.anthropic.com/api/model_selector/code'], { env: NOPROXY });
  const pj = json(pick.stdout);
  inp.claudeCatalog = pick.status === 0 && Array.isArray(pj?.model_selector_config) ? pj.model_selector_config.flatMap((c) => (c.models || []).map((m) => String(m.id))) : null;
  inp.claudeProbes = {};
  const settings = join(HOME, '.config/teamclaude-client/forge-check.settings.json');
  for (const c of CFG.claude) {
    let d = null;
    for (let i = 0; i < 2 && !(d && !d.is_error); i++) {   // one retry, as for the gateway
      if (i) await sleep(10_000);
      d = json(run('claude', ['-p', '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
        '--model', c.id, '--system-prompt', 'Answer with one word.', '--tools', '', '--output-format', 'json', 'Say ok.'], { timeout: 120_000, cwd: HOME }).stdout);
    }
    const served = Object.keys(d?.modelUsage || {});
    inp.claudeProbes[c.id] = { ok: !!d && !d.is_error, served, error: d ? (d.is_error ? 'error' : null) : 'no answer' };
  }
  // Foundry: deployments by Entra token (az's cached login), never an API key
  const conf = existsSync(join(HOME, '.config/xreview/foundry.conf')) ? readFileSync(join(HOME, '.config/xreview/foundry.conf'), 'utf8') : '';
  const ep = (conf.match(/^FOUNDRY_ENDPOINT=(.+)$/m)?.[1] || '').replace(/["'\s]/g, '').replace(/\/$/, '');
  const tok = run('az', ['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--query', 'accessToken', '-o', 'tsv'], { env: NOPROXY, timeout: 60_000 }).stdout?.trim();
  inp.foundry = null;
  if (/^https:\/\/[a-z0-9-]+\.cognitiveservices\.azure\.com$/.test(ep) && tok) {
    const r = await get(`${ep}/openai/deployments?api-version=2022-12-01`, { Authorization: `Bearer ${tok}` });
    const d = r.status === 200 ? json(r.body.toString()) : null;
    if (Array.isArray(d?.data)) inp.foundry = d.data.map((x) => ({ id: String(x.id), model: String(x.model || ''), status: String(x.status || '') }));
  }
  const nk = vault(CFG.vault.nebius);
  inp.nebius = null;
  if (nk) {
    const r = await get('https://api.tokenfactory.nebius.com/v1/models', { Authorization: `Bearer ${nk}` });
    const d = r.status === 200 ? json(r.body.toString()) : null;
    if (Array.isArray(d?.data)) inp.nebius = d.data.map((m) => String(m.id));
  }
  inp.speech = null;
  const sk = vault(CFG.vault.speech);
  if (sk) {
    inp.speech = {};
    let wav = null;
    for (const s of CFG.speech.filter((x) => x.kind === 'tts')) {
      const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='${s.id}'>The forge is lit.</voice></speak>`;
      const r = await get(`https://${CFG.speechRegions.tts}.tts.speech.microsoft.com/cognitiveservices/v1`, { 'Ocp-Apim-Subscription-Key': sk, 'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'riff-16khz-16bit-mono-pcm', 'User-Agent': 'forge-models' }, 30_000, 'POST', ssml);
      inp.speech[s.id] = { ok: r.status === 200 && r.body.length > 1000, error: r.status === 200 ? null : `http ${r.status}` };
      if (inp.speech[s.id].ok && !wav) wav = r.body;
    }
    for (const s of CFG.speech.filter((x) => x.kind === 'asr')) {
      if (!wav) { inp.speech[s.id] = { ok: false, error: 'no audio to transcribe' }; continue; }
      const r = await get(`https://${CFG.speechRegions.stt}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`,
        { 'Ocp-Apim-Subscription-Key': sk, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000' }, 30_000, 'POST', wav);
      const d = r.status === 200 ? json(r.body.toString()) : null;
      inp.speech[s.id] = { ok: d?.RecognitionStatus === 'Success' && /forge/i.test(d?.DisplayText || ''), error: d ? null : `http ${r.status}` };
    }
  }
  const units = [];
  for (const scope of [['--user'], []]) {
    const r = run('systemctl', [...scope, 'list-units', '--type=service', '--state=running', '--no-legend', '--plain'], { timeout: 30_000 });
    if (r.status === 0) units.push(...r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).map((u) => u.replace(/\.service$/, '')));
  }
  const dk = run('docker', ['ps', '--format', '{{.Names}}'], { timeout: 30_000 });
  inp.units = units.length ? [...units, ...(dk.status === 0 ? dk.stdout.split('\n').filter(Boolean) : [])] : null;
  const kt = await get('http://katana:11434/api/tags', {}, 5_000);
  inp.katanaTags = kt.status === 200 ? (json(kt.body.toString())?.models || []).map((m) => String(m.name)) : null;
  const eh = await get(CFG.local.find((l) => l.health)?.health || 'http://127.0.0.1:1/', {}, 5_000);
  inp.embedHealth = eh.status === 200;
  inp.wake = await new Promise((res) => {
    const port = CFG.local.find((l) => l.wyoming)?.wyoming;
    const s = connect({ host: '127.0.0.1', port }, () => s.write('{"type": "describe"}\n'));
    let buf = '';
    s.setTimeout(5000, () => { s.destroy(); res(null); });
    s.on('error', () => res(null));
    s.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n'); if (nl < 0) return;
      const hdr = json(buf.slice(0, nl)); const need = hdr?.data_length || 0;
      if (buf.length - nl - 1 < need) return;
      const data = need ? json(buf.slice(nl + 1, nl + 1 + need)) : hdr?.data;
      s.destroy();
      res((data?.wake || []).flatMap((p) => (p.models || []).map((m) => String(m.name))));
    });
  });
  return inp;
}

// ---------- the verdict (pure)
export function judge(cfg, inp, nowMs) {
  const unlisted = [], unreachable = [], drift = [], unread = [], asleep = [];
  const blocked = { foundry_claude: 0, foundry_third_party: 0 };
  const reg = inp.registry;
  if (!reg) unread.push('gateway registry');
  const enabled = (reg || []).filter((m) => m.enabled);
  const upstreams = new Set(enabled.map((m) => m.upstream).filter(Boolean));
  const asleepStems = new Set();
  // the host feed
  for (const [stem, gw] of Object.entries(cfg.feedStems)) {
    const f = inp.feed?.[stem];
    const t = Date.parse(f?.ts || '');
    if (!f || !Number.isFinite(t) || nowMs - t > FEED_STALE_MS) { unread.push(`host feed ${stem}`); continue; }
    if (f.state === 'asleep') { asleep.push(stem); asleepStems.add(gw); }
    else if (f.state === 'down' && !gw) unreachable.push(stem);   // an LLM stem is judged by its gateway probe below
  }
  for (const m of enabled) {
    const p = inp.gatewayProbes?.[m.name];
    if (p?.ok) continue;
    if (asleepStems.has(m.name)) continue;   // a desktop asleep: warn above, not unreachable
    unreachable.push(`${m.name}${p?.error ? ` (${p.error})` : ''}`);
  }
  // Claude seats
  const cl = new Set(cfg.claude.map((c) => c.id));
  if (!inp.claudeCatalog) unread.push('seat model catalog');
  else {
    for (const id of inp.claudeCatalog) if (!cl.has(id)) unlisted.push(`claude:${id}`);
    for (const id of cl) if (!inp.claudeCatalog.includes(id)) unreachable.push(`${id} (left the seat catalog)`);
  }
  for (const c of cfg.claude) {
    const p = inp.claudeProbes?.[c.id];
    if (!p) continue;
    if (!p.ok) unreachable.push(`${c.id} (${p.error || 'error'})`);
    else if (!p.served.includes(c.id)) unreachable.push(`${c.id} (served as ${p.served.join('+') || 'nothing'})`);
  }
  // Foundry
  const fd = new Map((inp.foundry || []).map((d) => [d.id, d]));
  const direct = new Set(cfg.foundryDirect.map((d) => d.deployment));
  if (!inp.foundry) unread.push('Foundry deployments');
  else {
    const coveredModels = new Set([...upstreams].filter((u) => u.startsWith('azure/')).map((u) => cfg.foundryExpect[u.slice(6)]).concat([...direct].map((d) => cfg.foundryExpect[d])).filter(Boolean));
    for (const d of inp.foundry) {
      if (d.status !== 'succeeded') continue;   // a failed deployment (sora-2) serves nothing
      if (/claude|anthropic/i.test(`${d.id} ${d.model}`)) { blocked.foundry_claude++; continue; }
      if (cfg.foundryBlocked[d.id]) { blocked.foundry_third_party++; continue; }
      const want = cfg.foundryExpect[d.id];
      if (!want) unlisted.push(`foundry:${d.id} (${d.model})`);
      else if (!upstreams.has(`azure/${d.id}`) && !direct.has(d.id) && !coveredModels.has(want)) unlisted.push(`foundry:${d.id}`);
    }
    const mine = [...[...upstreams].filter((u) => u.startsWith('azure/')).map((u) => u.slice(6)), ...direct];
    for (const id of mine) {
      const d = fd.get(id);
      if (!d || d.status !== 'succeeded') { unreachable.push(`foundry:${id} (deployment ${d ? d.status : 'gone'})`); continue; }
      if (d.model !== cfg.foundryExpect[id] || /claude|anthropic/i.test(d.model)) drift.push(`foundry:${id} now serves ${d.model}`);
    }
  }
  // Nebius
  if (!inp.nebius) unread.push('Nebius catalog (vault locked?)');
  else for (const id of inp.nebius) if (!upstreams.has(`nebius/${id}`)) unlisted.push(`nebius:${id}`);
  // Azure Speech
  if (!inp.speech) unread.push('Azure Speech (vault locked?)');
  else for (const s of cfg.speech) if (!inp.speech[s.id]?.ok) unreachable.push(`${s.id} (${inp.speech[s.id]?.error || 'no answer'})`);
  // local units, katana's tags, other local models
  if (!inp.units) unread.push('running units');
  else for (const u of new Set(inp.units)) if (MODEL_UNIT.test(u) && !NOT_A_MODEL.test(u) && !(u in cfg.localUnits)) unlisted.push(`unit:${u}`);
  if (inp.katanaTags) for (const t of inp.katanaTags) if (!(t in cfg.katanaTags)) unlisted.push(`katana:${t}`);
  const localOk = { embedding: !!inp.embedHealth, wake: Array.isArray(inp.wake) && inp.wake.length > 0 };
  for (const l of cfg.local) if (!localOk[l.kind]) unreachable.push(`${l.id} (no answer)`);

  const nGateway = enabled.length, nFeed = Object.values(cfg.feedStems).filter((g) => !g).length;
  const nDirect = cfg.claude.length + cfg.speech.length + cfg.foundryDirect.length + cfg.local.length;
  const state = unlisted.length || unreachable.length || drift.length ? 'fail' : unread.length || asleep.length ? 'warn' : 'ok';
  const few = (a) => a.slice(0, 6).join(', ') + (a.length > 6 ? ` +${a.length - 6} more` : '');
  let fact = `${nGateway + nFeed + nDirect} listed (${nGateway} gateway, ${nFeed} host-feed voices, ${nDirect} direct)`;
  fact += unreachable.length ? `; didn't answer: ${few(unreachable)}` : '; every listed model answered';
  if (unlisted.length) fact += `; reachable but unlisted: ${few(unlisted)}`;
  if (drift.length) fact += `; deployment drift: ${few(drift)}`;
  if (asleep.length) fact += `; asleep: ${asleep.join(', ')}`;
  if (unread.length) fact += `; not read: ${few(unread)}`;
  fact += `; blocked on Foundry: ${blocked.foundry_claude} Claude, ${blocked.foundry_third_party} third-party`;

  const at = new Date(nowMs).toISOString();
  const row = (o, ok, error, instrument) => ({ ...o, reachable: !!ok, checked: at, instrument, error: ok ? null : (error || 'no answer') });
  const rows = [
    ...cfg.claude.map((c) => { const p = inp.claudeProbes?.[c.id]; const ok = p?.ok && p.served.includes(c.id);
      return row({ name: c.id, label: c.label, route: 'teamclaude', kind: 'llm', group: c.group, tier: 'seat', policy: 'claude-teamclaude-only' }, ok, p ? (p.ok ? 'served as another model' : p.error) : 'not probed', 'claude -p through the seats'); }),
    ...cfg.speech.map((s) => row({ name: s.id, label: s.label, route: 'azure-speech', kind: s.kind, tier: 'credit', policy: s.policy }, inp.speech?.[s.id]?.ok, inp.speech ? inp.speech[s.id]?.error : 'not read', s.kind === 'tts' ? 'one sentence synthesized' : 'the synthesized sentence transcribed')),
    ...cfg.foundryDirect.map((f) => { const d = fd.get(f.deployment); const ok = d?.status === 'succeeded' && d.model === cfg.foundryExpect[f.deployment];
      return row({ name: f.deployment, label: f.label, route: 'foundry-direct', kind: f.kind, tier: 'credit', policy: 'foundry-first-party' }, ok, inp.foundry ? (d ? `deployment ${d.status}` : 'deployment gone') : 'not read', 'deployment state'); }),
    ...cfg.local.map((l) => row({ name: l.id, label: l.label, route: 'local', kind: l.kind, host: l.host, tier: 'local', policy: 'local' }, localOk[l.kind], null, l.health ? 'health endpoint' : 'wyoming describe')),
  ];
  return { state, fact, unlisted, unreachable, drift, unread, asleep, blocked,
    direct: { schema: 'forge.direct/v1', ts: at, poller: 'teamclaude-check-forge-models', models: rows, blocked } };
}

function publish(doc, out) {
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n', { mode: 0o640, flag: 'wx' });
  renameSync(tmp, out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = Number(process.env.CHECK_FM_NOW_MS) || Date.now();
  let inp;
  try { inp = process.env.CHECK_FM_INPUTS ? JSON.parse(readFileSync(process.env.CHECK_FM_INPUTS, 'utf8')) : await collect(); }
  catch (e) { process.stdout.write(`fail\tcheck crashed reading its sources (${e?.name || 'error'})\n`); process.exit(0); }
  const v = judge(CFG, inp, now);
  const out = process.env.CHECK_FM_OUT || join(PLAN, 'direct.json');
  let fact = v.fact;
  try { if (existsSync(dirname(out)) || process.env.CHECK_FM_OUT) publish(v.direct, out); else fact += '; plan data dir missing, direct.json not written'; }
  catch (e) { fact += `; direct.json not written (${e?.code || 'error'})`; }
  process.stdout.write(`${v.state}\t${fact.replace(/[\t\n\r]/g, ' ')}\n`);
}
