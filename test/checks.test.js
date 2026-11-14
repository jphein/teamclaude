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
  for (const body of ['{"accounts":[]}', 'not json', '{"aggregate":{"fiveHour":{"remaining":"x"},"weeklyShared":{"remaining":0.5}}}']) {
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
  for (const state of ['runs-rc0', 'envsh-off', 'none']) {
    const r = pw({ [SELF]: OK, waki: `proxy=200 wrapper=${state}` });
    assert.equal(r.status, 0);
    assert.match(r.line, new RegExp(`^CHECK proxy-wrapper warn · waki claude can run outside the pool \\(${state}\\) — `), state);
  }
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
const probe = (h, port) => new Promise((resolve, reject) => {
  execFile('bash', [join(C, 'proxy-probe.sh')], { env: { PATH: process.env.PATH, HOME: h, CHECK_PROXY_PORT: String(port) }, encoding: 'utf8', timeout: 60_000 },
    (err, stdout) => (err && err.code !== 0 ? reject(err) : resolve(stdout.trim())));
});
const NEW_WRAPPER = readFileSync(join(ROOT, 'scripts', 'claude-wrapper.sh'), 'utf8');
// the pre-#66 wrapper: falls back to the own login when :3456 is down
const OLD_WRAPPER = '#!/bin/sh\nREAL=$(readlink -f "$HOME/.local/bin/claude")\nif [ -z "$TEAMCLAUDE_BYPASS" ] && timeout 2 bash -c \': </dev/tcp/127.0.0.1/3456\' 2>/dev/null; then\n  export HTTPS_PROXY=http://127.0.0.1:3456\nelse\n  echo "[claude] teamclaude tunnel down; using own login" >&2\nfi\nexec "$REAL" "$@"\n';

test('proxy-probe: the current wrapper refuses; the old fallback wrapper is caught', async () => {
  await withServer(200, async (port) => {
    assert.equal(await probe(home(NEW_WRAPPER), port), 'proxy=200 wrapper=refuses');
    assert.equal(await probe(home(OLD_WRAPPER), port), 'proxy=200 wrapper=runs-rc0');
  });
});

test('proxy-probe: katana-style env.sh is judged by where HTTPS_PROXY points', async () => {
  await withServer(200, async (port) => {
    assert.equal(await probe(home(null, 'export HTTPS_PROXY=https://key:key@10.0.6.145:3443\n'), port), 'proxy=200 wrapper=envsh-pool');
    assert.equal(await probe(home(null, 'export HTTPS_PROXY=http://127.0.0.1:3456\n'), port), 'proxy=200 wrapper=envsh-pool');
    assert.equal(await probe(home(null, '# cc direct\nunset HTTPS_PROXY\n'), port), 'proxy=200 wrapper=envsh-off');
    assert.equal(await probe(home(null, '# export HTTPS_PROXY=http://127.0.0.1:3456\n'), port), 'proxy=200 wrapper=envsh-off');
    assert.equal(await probe(home(null, null), port), 'proxy=200 wrapper=none');
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
  r = fk(`KEYS|3\nIDLE|mail-sort\nIDLE|star-route\n${END}`);
  assert.match(r.line, /unused 30 days \(prune candidates\): mail-sort star-route/);
  r = fk('KEYS|3\nUNKNOWN|7|3\nREFUSED|0|0\nEND\n');
  assert.match(r.line, /^CHECK forge-keys warn · .*unknown keys spent: 7 calls from 3 keys in 7 days/);
  assert.equal(r.status, 0);
});

test('forge-keys: an unreadable or cut-off database answer fails, never reads as clean', () => {
  let r = fk('', { rc: 1 });
  assert.equal(r.status, 1); assert.match(r.line, /^CHECK forge-keys fail · cannot read the gateway database/);
  r = fk('KEYS|12\nUNKNOWN|0|0\n');
  assert.equal(r.status, 1); assert.match(r.line, /^CHECK forge-keys fail · gateway database answered incompletely/);
  r = fk('UNKNOWN|0|0\nREFUSED|0|0\nEND\n');
  assert.equal(r.status, 1); assert.match(r.line, /answered incompletely/);
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
