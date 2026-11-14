// scripts/checks/*: the CHECK timers (docs/CHECKS.md). Each script runs for real against fixtures:
// a quota JSON file, a canned per-host probe, canned psql output, state files, and the real new and
// old claude wrappers for the probe.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync, utimesSync, copyFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = join(ROOT, 'scripts', 'checks');
const dir = mkdtempSync(join(tmpdir(), 'tc-checks-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = join(dir, `s${n++}`); mkdirSync(d, { recursive: true }); return d; };
const BASE_ENV = { PATH: process.env.PATH, HOME: dir };

function run(script, env = {}, args = []) {
  const state = env.CHECK_STATE_DIR ?? fresh();
  const r = spawnSync('bash', [join(C, script), ...args], { env: { ...BASE_ENV, CHECK_STATE_DIR: state, ...env }, encoding: 'utf8', timeout: 60_000 });
  return { ...r, state, line: r.stdout.trim() };
}
const LINE = /^CHECK [a-z-]+ (ok|warn|fail) · .+ · .+$/;

// ---------- pool-quota
const NOW = 1_794_680_000_000;
const seat = (name, fiveUtil, weekUtil, extra = {}) => ({
  name, type: 'oauth', disabled: false, status: 'active',
  buckets: {
    fiveHour: fiveUtil == null ? null : { utilization: fiveUtil, remaining: 1 - fiveUtil, resetAt: NOW + 3_600_000 },
    weeklyShared: { utilization: weekUtil, remaining: 1 - weekUtil, resetAt: NOW + 86_400_000 },
  },
  ...extra,
});
const quota = (five, week, accounts) => ({ aggregate: { fiveHour: { remaining: five }, weeklyShared: { remaining: week } }, accounts });
function pq(body, extraEnv = {}) {
  const f = join(fresh(), 'q.json');
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return run('pool-quota.sh', { CHECK_QUOTA_FILE: f, CHECK_NOW_MS: String(NOW), ...extraEnv });
}

test('pool-quota: healthy pool is ok, names no seat by email', () => {
  const r = pq(quota(0.8, 0.6, [seat('a@x.org', 0.1, 0.2), seat('b@x.org', null, 0.5)]));
  assert.equal(r.status, 0);
  assert.match(r.line, LINE);
  assert.match(r.line, /^CHECK pool-quota ok · 5h 80% left, week 60% left, seats ≥90% used: none, at \d\d:\d\d · /);
  assert.doesNotMatch(r.line, /@/);
  assert.equal(readFileSync(join(r.state, 'pool-quota.last'), 'utf8').trim(), r.line);
});

test('pool-quota: weekly under 30% warns; 5h under 15% warns; seats ≥90% are named by local part', () => {
  let r = pq(quota(0.8, 0.29, [seat('claude3@x.org', null, 0.9), seat('b@x.org', 0.95, 0.1), seat('c@x.org', 0.2, 0.89)]));
  assert.equal(r.status, 0);
  assert.match(r.line, /^CHECK pool-quota warn · 5h 80% left, week 29% left \(week under 30%\), seats ≥90% used: claude3 b, /);
  r = pq(quota(0.14, 0.5, [seat('a@x.org', 0.86, 0.5)]));
  assert.match(r.line, /^CHECK pool-quota warn · 5h 14% left, week 50% left \(5h under 15%\)/);
  r = pq(quota(0.15, 0.30, [seat('a@x.org', 0.85, 0.7)]));
  assert.match(r.line, /^CHECK pool-quota ok /, 'exactly at the thresholds is not under them');
});

test('pool-quota: a bucket reset more than 15 min ago that still shows usage is stale and warns', () => {
  const stale = seat('old@x.org', 0.4, 0.2);
  stale.buckets.fiveHour.resetAt = NOW - 16 * 60_000;
  const recent = seat('new@x.org', 0.4, 0.2);
  recent.buckets.fiveHour.resetAt = NOW - 10 * 60_000;
  const r = pq(quota(0.8, 0.6, [stale, recent]));
  assert.match(r.line, /^CHECK pool-quota warn · .*\(stale buckets: old\)/);
});

test('pool-quota: disabled seats are ignored; a seat not active is named', () => {
  const r = pq(quota(0.8, 0.6, [seat('off@x.org', 0.99, 0.99, { disabled: true }), seat('re@x.org', 0.1, 0.1, { status: 'needs-reauth' })]));
  assert.match(r.line, /seats ≥90% used: none, not active: re=needs-reauth, /);
});

test('pool-quota: no aggregate, bad JSON or no endpoint is a fail (exit 1)', () => {
  for (const body of ['{"accounts":[]}', 'not json',
    '{"aggregate":{"fiveHour":{"remaining":0.8},"weeklyShared":{"remaining":0.8}},"accounts":[]}\n{}',
    '{"aggregate":{"fiveHour":{"remaining":0.8},"weeklyShared":{"remaining":0.8}},"accounts":[]}\n{"aggregate":{"fiveHour":{"remaining":0.8},"weeklyShared":{"remaining":0.8}},"accounts":[]}', '{"aggregate":{"fiveHour":{"remaining":"x"},"weeklyShared":{"remaining":0.5}}}']) {
    const r = pq(body);
    assert.equal(r.status, 1, body);
    assert.match(r.line, /^CHECK pool-quota fail · quota endpoint answered without aggregate numbers/);
  }
  const r = run('pool-quota.sh', { CHECK_QUOTA_URL: 'http://127.0.0.1:1/teamclaude/quota' });
  assert.equal(r.status, 1);
  assert.match(r.line, /^CHECK pool-quota fail · quota endpoint http:\/\/127\.0\.0\.1:1\/teamclaude\/quota did not answer/);
});

// ---------- proxy-wrapper (assessment, with a canned probe)
const SELF = spawnSync('hostname', ['-s'], { encoding: 'utf8' }).stdout.trim() || hostname();
function pw(results) { // host -> probe line ('' = unreachable)
  const d = fresh(); const p = join(d, 'probe');
  writeFileSync(p, `#!/bin/sh\ncase "$1" in\n${Object.entries(results).map(([h, l]) => `  ${h}) ${l ? `echo '${l}'` : 'exit 255'} ;;`).join('\n')}\nesac\n`);
  chmodSync(p, 0o755);
  return run('proxy-wrapper.sh', { CHECK_HOSTS: Object.keys(results).join(' '), CHECK_PROBE: p });
}
const OK = 'proxy=200 wrapper=refuses';

test('proxy-wrapper: all forwarders up and every claude fails closed is ok', () => {
  const r = pw({ [SELF]: OK, waki: OK, kat: 'proxy=200 wrapper=envsh-pool' });
  assert.equal(r.status, 0);
  assert.match(r.line, new RegExp(`^CHECK proxy-wrapper ok · ${SELF} :3456 200, wrapper refuses; waki :3456 200, wrapper refuses; kat :3456 200, wrapper envsh-pool, at `));
});

test('proxy-wrapper: another host down or unreachable warns; this host down fails', () => {
  let r = pw({ [SELF]: OK, waki: 'proxy=000 wrapper=refuses' });
  assert.equal(r.status, 0); assert.match(r.line, /^CHECK proxy-wrapper warn · waki forwarder 000 — /);
  r = pw({ [SELF]: OK, waki: '' });
  assert.match(r.line, /^CHECK proxy-wrapper warn · waki unreachable — /);
  r = pw({ [SELF]: 'proxy=502 wrapper=refuses', waki: OK });
  assert.equal(r.status, 1); assert.match(r.line, new RegExp(`^CHECK proxy-wrapper fail · ${SELF} forwarder 502 — `));
});

test('proxy-wrapper: a claude that would run outside the pool warns', () => {
  for (const state of ['envsh-off', 'none']) {
    const r = pw({ [SELF]: OK, waki: `proxy=200 wrapper=${state}` });
    assert.equal(r.status, 0);
    assert.match(r.line, new RegExp(`^CHECK proxy-wrapper warn · waki claude can run outside the pool \\(${state}\\) — `), state);
  }
});

test('proxy-wrapper: a probe that exits non-zero is unreachable even if its line looks healthy', () => {
  const d = fresh(); const p = join(d, 'probe');
  writeFileSync(p, `#!/bin/sh\necho 'proxy=200 wrapper=refuses'\nexit 1\n`); chmodSync(p, 0o755);
  const r = run('proxy-wrapper.sh', { CHECK_HOSTS: 'waki', CHECK_PROBE: p });
  assert.match(r.line, /^CHECK proxy-wrapper warn · waki unreachable/);
});

test('proxy-wrapper: an env.sh whose NO_PROXY skips the pool warns', () => {
  const r = pw({ [SELF]: OK, kat: 'proxy=200 wrapper=envsh-bypass' });
  assert.match(r.line, /^CHECK proxy-wrapper warn · kat env\.sh NO_PROXY lets claude skip the pool — /);
});

test('proxy-wrapper: an env.sh that cannot be read without running it warns', () => {
  const r = pw({ [SELF]: OK, kat: 'proxy=200 wrapper=envsh-unverifiable' });
  assert.match(r.line, /^CHECK proxy-wrapper warn · kat env\.sh cannot be read without running it — /);
});

test('proxy-wrapper: a wrapper that is not the reviewed one warns', () => {
  const r = pw({ [SELF]: OK, waki: 'proxy=200 wrapper=wrapper-1b2c3d4e' });
  assert.match(r.line, /^CHECK proxy-wrapper warn · waki ~\/\.cargo\/bin\/claude is not the reviewed wrapper \(wrapper-1b2c3d4e\) — /);
});

test('proxy-wrapper: the probe is handed the reviewed wrapper\'s sha256', () => {
  const d = fresh(); const p = join(d, 'probe'); const seen = join(d, 'seen');
  writeFileSync(p, `#!/bin/sh\necho "$2" > '${seen}'\necho 'proxy=200 wrapper=refuses'\n`); chmodSync(p, 0o755);
  run('proxy-wrapper.sh', { CHECK_HOSTS: 'waki', CHECK_PROBE: p });
  assert.equal(readFileSync(seen, 'utf8').trim(), sha(NEW_WRAPPER));
});

test('proxy-wrapper: a garbled probe line counts as unreachable', () => {
  const r = pw({ [SELF]: OK, waki: 'proxy=200 wrapper=refuses; rm -rf /' });
  assert.match(r.line, /^CHECK proxy-wrapper warn · waki unreachable/);
});

// ---------- proxy-probe (runs the real wrappers)
async function withServer(code, fn) {
  const srv = createServer((req, res) => { res.statusCode = code; res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(srv.address().port); } finally { await new Promise((r) => srv.close(r)); }
}
function home(wrapperSrc, envsh) {
  const h = fresh();
  mkdirSync(join(h, '.local', 'bin'), { recursive: true });
  writeFileSync(join(h, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n'); chmodSync(join(h, '.local', 'bin', 'claude'), 0o755);
  if (wrapperSrc) { mkdirSync(join(h, '.cargo', 'bin'), { recursive: true }); writeFileSync(join(h, '.cargo', 'bin', 'claude'), wrapperSrc); chmodSync(join(h, '.cargo', 'bin', 'claude'), 0o755); }
  if (envsh != null) { mkdirSync(join(h, '.config', 'claude-code'), { recursive: true }); writeFileSync(join(h, '.config', 'claude-code', 'env.sh'), envsh); }
  return h;
}
// async: a spawnSync would block this process's event loop, and the test server could never answer
const sha = (text) => createHash('sha256').update(text).digest('hex');
const probe = (h, port, extra = {}, opts = {}) => new Promise((resolve, reject) => {
  execFile('bash', [join(C, 'proxy-probe.sh'), sha(NEW_WRAPPER)], { ...opts, env: { PATH: process.env.PATH, HOME: h, CHECK_PROXY_PORT: String(port), ...extra }, encoding: 'utf8', timeout: 60_000 },
    (err, stdout) => (err && err.code !== 0 ? reject(err) : resolve(stdout.trim())));
});
const NEW_WRAPPER = readFileSync(join(ROOT, 'scripts', 'claude-wrapper.sh'), 'utf8');
// the pre-#66 wrapper: falls back to the own login when :3456 is down
const OLD_WRAPPER = '#!/bin/sh\nREAL=$(readlink -f "$HOME/.local/bin/claude")\nif [ -z "$TEAMCLAUDE_BYPASS" ] && timeout 2 bash -c \': </dev/tcp/127.0.0.1/3456\' 2>/dev/null; then\n  export HTTPS_PROXY=http://127.0.0.1:3456\nelse\n  echo "[claude] teamclaude tunnel down; using own login" >&2\nfi\nexec "$REAL" "$@"\n';

test('proxy-probe: the reviewed wrapper reads refuses; any other wrapper is named by hash and never run', async () => {
  await withServer(200, async (port) => {
    assert.equal(await probe(home(NEW_WRAPPER), port), 'proxy=200 wrapper=refuses');
    assert.equal(await probe(home(OLD_WRAPPER), port), `proxy=200 wrapper=wrapper-${sha(OLD_WRAPPER).slice(0, 8)}`);
    const rogue = '#!/bin/sh\ntouch "$HOME/probe-ran-me"\nexit 69\n';
    const h = home(rogue);
    assert.equal(await probe(h, port), `proxy=200 wrapper=wrapper-${sha(rogue).slice(0, 8)}`);
    assert.equal(existsSync(join(h, 'probe-ran-me')), false, 'the probe executed the wrapper');
    const nx = home(NEW_WRAPPER); chmodSync(join(nx, '.cargo', 'bin', 'claude'), 0o644);
    assert.equal(await probe(nx, port), 'proxy=200 wrapper=wrapper-notexec', 'a non-executable reviewed wrapper is skipped by PATH');
  });
});

// an env.sh body that settles all four proxy variables first, so the case tests its content
const envs = (body) => home(null, 'unset HTTPS_PROXY https_proxy NO_PROXY no_proxy\n' + body);
test('proxy-probe: katana-style env.sh is judged by where HTTPS_PROXY points', async () => {
  await withServer(200, async (port) => {
    assert.equal(await probe(envs('export HTTPS_PROXY=https://key:key@10.0.6.145:3443\n'), port), 'proxy=200 wrapper=envsh-pool');
    assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:3456\n'), port), 'proxy=200 wrapper=envsh-pool');
    assert.equal(await probe(envs('# cc direct\nunset HTTPS_PROXY\n'), port), 'proxy=200 wrapper=envsh-off');
    assert.equal(await probe(envs('# export HTTPS_PROXY=http://127.0.0.1:3456\n'), port), 'proxy=200 wrapper=envsh-off');
    assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:34560\n'), port), 'proxy=200 wrapper=envsh-off', 'another port');
    assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:3456#x\n'), port), 'proxy=200 wrapper=envsh-off', 'a # touching the value is part of it, as in bash');
    for (const loc of ['C', 'C.UTF-8'])
      assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:3456\u2003\n'), port, { LC_ALL: loc }), 'proxy=200 wrapper=envsh-off', `an EM SPACE stays in the value (${loc})`);
    const P = 'export HTTPS_PROXY=http://127.0.0.1:3456\n';
    for (const [body, want, why] of [
      [P + "export NO_PROXY='*'\n", 'envsh-bypass', 'NO_PROXY=*'],
      [P + 'export no_proxy=localhost,.anthropic.com\n', 'envsh-bypass', 'no_proxy names anthropic'],
      [P + 'export NO_PROXY=claude.ai\n', 'envsh-bypass', 'NO_PROXY names claude.ai'],
      [P + 'export NO_PROXY=api.claude.ai\n', 'envsh-pool', 'a subdomain entry does not cover its parent claude.ai'],
      [P + 'export NO_PROXY=API.ANTHROPIC.COM\n', 'envsh-bypass', 'host matching is case-insensitive'],
      [P + 'export NO_PROXY=anthropic.com\n', 'envsh-bypass', 'a parent domain'],
      [P + "export NO_PROXY='*.anthropic.com:443'\n", 'envsh-bypass', 'a *. entry with a port'],
      [P + 'export NO_PROXY=claude.invalid,anthropic.example.org,notanthropic.com,thropic.com\n', 'envsh-pool', 'look-alikes and substrings are not the hosts'],
      [P + "export NO_PROXY='*anthropic.com'\n", 'envsh-pool', 'a * that is not *. stays literal'],
      [P + "export NO_PROXY='api.anthropic.com:80'\n", 'envsh-pool', 'another port does not cover 443'],
      [P + "export NO_PROXY='api.anthropic.com:443'\n", 'envsh-bypass', 'port 443 does'],
      [P + "export NO_PROXY='api.anth ropic.com'\n", 'envsh-pool', 'a blank separates entries, never joins them'],
      [P + "export NO_PROXY='localhost claude.ai'\n", 'envsh-bypass', 'a blank-separated list'],
      [P + 'export NO_PROXY=" localhost , *"\n', 'envsh-bypass', 'a spaced * entry'],
      [P + "export NO_PROXY='*'\nunset NO_PROXY\n", 'envsh-pool', 'a later unset clears the bypass'],
      [P + 'export NO_PROXY=localhost,127.0.0.1,10.0.0.0/8,.jphe.in\n', 'envsh-pool', 'a LAN-only NO_PROXY'],
      [P + 'export https_proxy=http://elsewhere:8080\n', 'envsh-off', 'lowercase https_proxy wins in Node and points elsewhere'],
      ['export https_proxy=http://127.0.0.1:3456\n', 'envsh-pool', 'lowercase alone at the pool'],
      ['export HTTPS_PROXY=https://k@x@10.0.6.145:3443\n', 'envsh-off', 'userinfo is token characters only'],
    ]) assert.equal(await probe(envs(body), port), `proxy=200 wrapper=${want}`, why);
    for (const ws of ['\v', '\f'])
      assert.equal(await probe(envs(`export HTTPS_PROXY=http://127.0.0.1:3456${ws}\n`), port), 'proxy=200 wrapper=envsh-off', `a trailing ${JSON.stringify(ws)} stays in the value, as in bash`);
    assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:3456\nunset HTTPS_PROXY\n'), port), 'proxy=200 wrapper=envsh-off', 'a later unset wins');
    assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:3456\nexport HTTPS_PROXY=http://elsewhere:1\n'), port), 'proxy=200 wrapper=envsh-off', 'a later export wins');
    assert.equal(await probe(envs('export HTTPS_PROXY=https://k@10.0.6.145:3443.evil\n'), port), 'proxy=200 wrapper=envsh-off', 'anchored host');
    assert.equal(await probe(envs('unset HTTPS_PROXY; exit 0\n'), port), 'proxy=200 wrapper=envsh-unverifiable', 'a compound line is not read');
    const mut = envs('touch "$HOME/probe-ran-envsh"\nexport HTTPS_PROXY=http://127.0.0.1:3456\n');
    assert.equal(await probe(mut, port), 'proxy=200 wrapper=envsh-unverifiable');
    assert.equal(existsSync(join(mut, 'probe-ran-envsh')), false, 'the probe executed env.sh');
    for (const v of ["'http://127.0.0.1:3456'", '"http://127.0.0.1:3456"', 'https://k:k@10.0.6.145:3443 # a comment'])
      assert.equal(await probe(envs(`export HTTPS_PROXY=${v}\n`), port), 'proxy=200 wrapper=envsh-pool', v);
    for (const body of ["export HTTPS_PROXY='http://127.0.0.1:3456'#$(printf suffix)\n", "export HTTPS_PROXY='http://127.0.0.1:3456'\r\n",
      'export HTTPS_PROXY=$POOL\n', 'export HTTPS_PROXY=http://127.0.0.1:3456\nexport NO_PROXY={example.org,anthropic.com}\n', 'export NO_PROXY=~/x\n', 'export NO_PROXY=*\n', 'if true; then export HTTPS_PROXY=http://127.0.0.1:3456; fi\n', '. ./other.sh\n', 'export HTTPS_PROXY=`cat x`\n'])
      assert.equal(await probe(envs(body), port), 'proxy=200 wrapper=envsh-unverifiable', body);
    const katana = '# Claude Code active backend: teamclaude\nunset CLAUDE_CODE_USE_BEDROCK ANTHROPIC_BASE_URL\nunset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy NODE_EXTRA_CA_CERTS\nexport TITLE=1  # Let shell set title\nexport HTTPS_PROXY=https://k:k@10.0.6.145:3443\nexport NO_PROXY=localhost,127.0.0.1\nexport no_proxy=localhost,127.0.0.1\nexport NODE_EXTRA_CA_CERTS=/home/u/.config/ca.pem\nunset ANTHROPIC_BASE_URL\n';
    assert.equal(await probe(home(null, katana), port), 'proxy=200 wrapper=envsh-pool', 'katana-shaped file');
    assert.equal(await probe(home(null, null), port), 'proxy=200 wrapper=none');
    // the file alone must decide: a variable it neither exports nor unsets comes from the caller
    assert.equal(await probe(home(null, 'export HTTPS_PROXY=http://127.0.0.1:3456\n'), port), 'proxy=200 wrapper=envsh-unverifiable', 'https_proxy/NO_PROXY left to the caller');
    assert.equal(await probe(home(null, 'unset HTTPS_PROXY https_proxy NO_PROXY\nexport HTTPS_PROXY=http://127.0.0.1:3456\n'), port), 'proxy=200 wrapper=envsh-unverifiable', 'no_proxy left to the caller');
    // a * entry must not be expanded as a file name in the probe's working directory
    const cwd = fresh(); writeFileSync(join(cwd, 'ordinary'), '');
    assert.equal(await probe(envs("export HTTPS_PROXY=http://127.0.0.1:3456\nexport NO_PROXY='*'\n"), port, {}, { cwd }), 'proxy=200 wrapper=envsh-bypass', 'glob in cwd');
  });
});

test('proxy-probe: a forwarder that errors or is down reports its code', async () => {
  await withServer(502, async (port) => assert.equal(await probe(home(NEW_WRAPPER), port), 'proxy=502 wrapper=refuses'));
  const srv = createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const { port } = srv.address(); await new Promise((r) => srv.close(r));
  assert.equal(await probe(home(NEW_WRAPPER), port), 'proxy=000 wrapper=refuses');
});

// ---------- forge-keys (canned psql output)
function fk(out, { rc = 0 } = {}) {
  const d = fresh(); const p = join(d, 'psql');
  writeFileSync(join(d, 'out'), out);
  writeFileSync(p, `#!/bin/sh\ncat >/dev/null\ncat '${join(d, 'out')}'\nexit ${rc}\n`); chmodSync(p, 0o755);
  return run('forge-keys.sh', { CHECK_FORGE_PSQL: p });
}
const END = 'UNKNOWN|0|0\nREFUSED|0|0\nEND\n';

test('forge-keys: a clean gateway is ok and reports refused calls by inactive keys', () => {
  const r = fk('KEYS|12\nUNKNOWN|0|0\nREFUSED|11|4\nEND\n');
  assert.equal(r.status, 0);
  assert.match(r.line, /^CHECK forge-keys ok · 12 active keys, none outside its allowlist, none idle 30 days, no unknown spenders, refused calls by inactive keys in 7 days: 11 \(4 by deleted keys\), at /);
});

test('forge-keys: spend outside an allowlist, an idle key or an unknown spender warns, naming aliases', () => {
  let r = fk(`KEYS|3\nOUT|ha-ember-2|donkey|2\n${END}`);
  assert.match(r.line, /^CHECK forge-keys warn · 3 active keys, spend outside allowlist: ha-ember-2→donkey ×2, /);
  r = fk(`KEYS|1\nIDLE|\n${END}`);
  assert.match(r.line, /^CHECK forge-keys warn · .*unused 30 days \(prune candidates\): \(no alias\)/);
  r = fk(`KEYS|1\nOUT||ember|1\n${END}`);
  assert.match(r.line, /^CHECK forge-keys warn · .*spend outside allowlist: \(no alias\)→ember ×1/);
  r = fk(`KEYS|3\nIDLE|mail-sort\nIDLE|star-route\n${END}`);
  assert.match(r.line, /unused 30 days \(prune candidates\): mail-sort star-route/);
  r = fk('KEYS|3\nUNKNOWN|7|3\nREFUSED|0|0\nEND\n');
  assert.match(r.line, /^CHECK forge-keys warn · .*unknown keys spent: 7 calls from 3 keys in 7 days/);
  assert.equal(r.status, 0);
});

test('forge-keys: aliases and model names reach the row protocol only through regexp_replace', () => {
  const d = fresh(); const p = join(d, 'psql'); const sql = join(d, 'sql');
  writeFileSync(p, `#!/bin/sh\ncat > '${sql}'\nprintf 'KEYS|1\\nUNKNOWN|0|0\\nREFUSED|0|0\\nEND\\n'\n`); chmodSync(p, 0o755);
  run('forge-keys.sh', { CHECK_FORGE_PSQL: p });
  const q = readFileSync(sql, 'utf8');
  assert.match(q, /SELECT 'OUT', regexp_replace\(coalesce\(t\.key_alias, ''\), '\[\^A-Za-z0-9\._:\/-\]', '\?', 'g'\),\s+regexp_replace\(s\.model_group, /);
  assert.match(q, /SELECT 'IDLE', regexp_replace\(coalesce\(t\.key_alias, ''\), /);
  assert.doesNotMatch(q, /SELECT 'OUT', coalesce\(t\.key_alias/);
});

test('forge-keys: an unreadable or cut-off database answer fails, never reads as clean', () => {
  let r = fk('', { rc: 1 });
  assert.equal(r.status, 1); assert.match(r.line, /^CHECK forge-keys fail · cannot read the gateway database/);
  r = fk('KEYS|12\nUNKNOWN|0|0\n');
  assert.equal(r.status, 1); assert.match(r.line, /^CHECK forge-keys fail · gateway database answered incompletely/);
  for (const bad of ['UNKNOWN|0|0\nREFUSED|0|0\nEND\n', 'KEYS|1\nEND\n', 'KEYS|1\nUNKNOWN|garbled|1\nREFUSED|0|0\nEND\n',
    'KEYS|1\nUNKNOWN|0|0\nUNKNOWN|5|1\nREFUSED|0|0\nEND\n', 'KEYS|1\nUNKNOWN|0|0\nREFUSED|0|0\nWHAT|x\nEND\n', 'KEYS|1\nUNKNOWN|0|0\nREFUSED|0|0\nOUT|a|b|many\nEND\n']) {
    r = fk(bad);
    assert.equal(r.status, 1, bad); assert.match(r.line, /answered incompletely or malformed/, bad);
  }
});

// ---------- summary
function summary(files, now = Math.floor(Date.now() / 1000)) {
  const d = fresh();
  for (const [name, [line, ageMin]] of Object.entries(files)) {
    const f = join(d, `${name}.last`); writeFileSync(f, `${line}\n`);
    const t = now - ageMin * 60; utimesSync(f, t, t);
  }
  return spawnSync('bash', [join(C, 'summary.sh')], { env: { PATH: process.env.PATH, CHECK_STATE_DIR: d, CHECK_NOW: String(now) }, encoding: 'utf8' });
}

test('summary: silent when every check is ok and fresh', () => {
  const r = summary({ 'pool-quota': ['CHECK pool-quota ok · x · y', 5], 'proxy-wrapper': ['CHECK proxy-wrapper ok · x · y', 5], 'forge-keys': ['CHECK forge-keys ok · x · y', 600] });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
});

test('summary: a malformed or multi-line result is a warn, never silence', () => {
  const r = summary({ 'pool-quota': ['CHECK pool-quota ok garbage', 5], 'proxy-wrapper': ['CHECK proxy-wrapper ok · x · y\nCHECK proxy-wrapper fail · z · y', 5], 'forge-keys': ['CHECK forge-keys ok · x · y', 5] });
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^CHECK pool-quota warn · last result is malformed/);
  assert.match(lines[1], /^CHECK proxy-wrapper warn · last result is malformed/);
});

test('summary: repeats warn/fail lines, flags a stale result and a missing one', () => {
  const r = summary({ 'pool-quota': ['CHECK pool-quota warn · week 29% · y', 5], 'proxy-wrapper': ['CHECK proxy-wrapper ok · x · y', 31] });
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'CHECK pool-quota warn · week 29% · y');
  assert.match(lines[1], /^CHECK proxy-wrapper warn · last result is 31 min old \(max 30\): timer stopped\? last: ok · x · y/);
  assert.match(lines[2], /^CHECK forge-keys warn · no result yet/);
});

// ---------- lib
test('lib: an unknown status becomes fail; the log keeps history', () => {
  const d = fresh();
  const r = spawnSync('bash', ['-c', `. '${join(C, 'lib.sh')}'; check_emit demo maybe "a fact" "next"`], { env: { ...BASE_ENV, CHECK_STATE_DIR: d }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), 'CHECK demo fail · bad status from the check itself: a fact · next');
  assert.ok(existsSync(join(d, 'demo.log')));
});

test('units: every check has a service and a timer; services run the installed copy', () => {
  for (const name of ['pool-quota', 'proxy-wrapper', 'forge-keys']) {
    const svc = readFileSync(join(C, 'systemd', `teamclaude-check-${name}.service`), 'utf8');
    assert.match(svc, new RegExp(`^ExecStart=%h/\\.local/libexec/teamclaude-checks/${name}\\.sh$`, 'm'));
    assert.match(readFileSync(join(C, 'systemd', `teamclaude-check-${name}.timer`), 'utf8'), /^Persistent=true$/m);
  }
});

// ---------- install (a real run into a temporary HOME, from a temporary repo whose origin/master is set)
function repoAt(files) {
  const d = fresh();
  const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q');
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), body); }
  g('add', '-A'); g('commit', '-q', '-m', 'x');
  g('update-ref', 'refs/remotes/origin/master', 'HEAD');
  return { dir: d, head: g('rev-parse', 'HEAD').stdout.trim() };
}
const payload = (omit = []) => {
  const files = {};
  for (const f of ['lib.sh', 'pool-quota.sh', 'proxy-probe.sh', 'proxy-wrapper.sh', 'forge-keys.sh', 'summary.sh', 'install.sh']) if (!omit.includes(f)) files[`scripts/checks/${f}`] = readFileSync(join(C, f), 'utf8');
  for (const n of ['pool-quota', 'proxy-wrapper', 'forge-keys']) for (const ext of ['service', 'timer']) files[`scripts/checks/systemd/teamclaude-check-${n}.${ext}`] = readFileSync(join(C, 'systemd', `teamclaude-check-${n}.${ext}`), 'utf8');
  files['scripts/claude-wrapper.sh'] = NEW_WRAPPER;
  return files;
};
function install(repo, h) {
  const fake = join(fresh(), 'systemctl'); writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${join(h, 'systemctl.log')}'\n`); chmodSync(fake, 0o755);
  return spawnSync('bash', [join(repo.dir, 'scripts', 'checks', 'install.sh'), repo.head], { cwd: repo.dir, env: { PATH: process.env.PATH, HOME: h, CHECK_SYSTEMCTL: fake }, encoding: 'utf8' });
}

test('install: a complete merged commit is published and its timers enabled', () => {
  const h = fresh(); const r = install(repoAt(payload()), h);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(h, '.local/libexec/teamclaude-checks/claude-wrapper.sh'), 'utf8'), NEW_WRAPPER);
  assert.ok(existsSync(join(h, '.config/systemd/user/teamclaude-check-forge-keys.timer')));
  assert.match(readFileSync(join(h, 'systemctl.log'), 'utf8'), /^--user enable --now teamclaude-check-pool-quota\.timer teamclaude-check-proxy-wrapper\.timer teamclaude-check-forge-keys\.timer$/m);
});

test('install: a commit missing a file publishes nothing over the existing install', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  const before = readFileSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh'), 'utf8');
  const broken = payload(['summary.sh']); broken['scripts/checks/pool-quota.sh'] = before + '\n# changed\n';
  const r = install(repoAt(broken), h);
  assert.equal(r.status, 4);
  assert.equal(readFileSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh'), 'utf8'), before, 'a partial payload was published');
});

test('install: a commit not on origin/master is refused', () => {
  const repo = repoAt(payload());
  spawnSync('git', ['update-ref', '-d', 'refs/remotes/origin/master'], { cwd: repo.dir });
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: repo.dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  spawnSync('git', ['update-ref', 'refs/remotes/origin/master', 'HEAD'], { cwd: repo.dir });
  spawnSync('git', ['checkout', '-q', '-b', 'side', 'HEAD~1'], { cwd: repo.dir });
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'side'], { cwd: repo.dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const side = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).stdout.trim();
  const h = fresh();
  const r = spawnSync('bash', [join(repo.dir, 'scripts', 'checks', 'install.sh'), side], { cwd: repo.dir, env: { PATH: process.env.PATH, HOME: h, CHECK_SYSTEMCTL: '/bin/false' }, encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.equal(existsSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh')), false);
});

test('install: a commit missing one unit publishes nothing', () => {
  const h = fresh();
  const files = payload(); delete files['scripts/checks/systemd/teamclaude-check-forge-keys.service'];
  const r = install(repoAt(files), h);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /not exactly the six check units; nothing installed/);
  assert.equal(existsSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh')), false);
});

test('install: a destination that is not a regular file publishes nothing', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  const lib = join(h, '.local/libexec/teamclaude-checks/pool-quota.sh');
  const before = readFileSync(lib, 'utf8');
  const unit = join(h, '.config/systemd/user/teamclaude-check-proxy-wrapper.timer');
  rmSync(unit); mkdirSync(join(unit, 'x'), { recursive: true });
  const changed = payload(); changed['scripts/checks/pool-quota.sh'] = before + '\n# changed\n';
  const r = install(repoAt(changed), h);
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /is not a regular file; nothing installed/);
  assert.equal(readFileSync(lib, 'utf8'), before);
});

test('install: a move that fails mid-publish restores every file already moved', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  const lib = join(h, '.local/libexec/teamclaude-checks/pool-quota.sh');
  const unit = join(h, '.config/systemd/user/teamclaude-check-pool-quota.timer');
  const before = readFileSync(lib, 'utf8'), unitBefore = readFileSync(unit, 'utf8');
  const changed = payload();
  changed['scripts/checks/pool-quota.sh'] = before + '\n# changed\n';
  changed['scripts/checks/systemd/teamclaude-check-pool-quota.timer'] = unitBefore + '\n# changed\n';
  const fake = join(fresh(), 'systemctl'); writeFileSync(fake, '#!/bin/sh\n'); chmodSync(fake, 0o755);
  const repo = repoAt(changed);
  const r = spawnSync('bash', [join(repo.dir, 'scripts', 'checks', 'install.sh'), repo.head], { cwd: repo.dir, env: { PATH: process.env.PATH, HOME: h, CHECK_SYSTEMCTL: fake, CHECK_INSTALL_FAIL_AT: 'teamclaude-check-proxy-wrapper.timer' }, encoding: 'utf8' });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /previous install is restored/);
  assert.equal(readFileSync(lib, 'utf8'), before, 'a moved script was not restored');
  assert.equal(readFileSync(unit, 'utf8'), unitBefore, 'a moved unit was not restored');
});

test('install: an unwritable destination publishes nothing', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  const lib = join(h, '.local/libexec/teamclaude-checks/pool-quota.sh');
  const before = readFileSync(lib, 'utf8');
  chmodSync(join(h, '.config/systemd/user'), 0o555);
  try {
    const changed = payload(); changed['scripts/checks/pool-quota.sh'] = before + '\n# changed\n';
    const r = install(repoAt(changed), h);
    assert.equal(r.status, 5, r.stderr);
    assert.equal(readFileSync(lib, 'utf8'), before);
  } finally { chmodSync(join(h, '.config/systemd/user'), 0o755); }
});

test('install: an extra unit file refuses the install; only the three named timers are enabled', () => {
  const h = fresh();
  const files = payload(); files['scripts/checks/systemd/unexpected.timer'] = '[Timer]\nOnCalendar=*:*\n'; files['scripts/checks/systemd/unexpected.service'] = '[Service]\nExecStart=/bin/true\n';
  const r = install(repoAt(files), h);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /not exactly the six check units/);
  assert.equal(existsSync(join(h, '.config/systemd/user/unexpected.timer')), false);
  assert.equal(existsSync(join(h, 'systemctl.log')), false);
});
