// scripts/checks/*: the CHECK timers (docs/CHECKS.md). Each script runs for real against fixtures:
// a quota JSON file, a canned per-host probe, canned psql output, state files, and the real new and
// old claude wrappers for the probe.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync, utimesSync, copyFileSync, existsSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { tmpdir, hostname, userInfo } from 'node:os';
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
  assert.equal(readFileSync(join(r.state, 'pool-quota.line'), 'utf8').trim(), r.line);
});

test('pool-quota: weekly at or under 15% warns, at or under 5% fails; 5h under 15% warns; seats ≥90% named', () => {
  let r = pq(quota(0.8, 0.15, [seat('claude3@x.org', null, 0.9), seat('b@x.org', 0.95, 0.1), seat('c@x.org', 0.2, 0.89)]));
  assert.equal(r.status, 0);
  assert.match(r.line, /^CHECK pool-quota warn · 5h 80% left, week 15% left \(week at or under 15%\), seats ≥90% used: claude3 b, /);
  r = pq(quota(0.8, 0.05, [seat('a@x.org', 0.2, 0.95)]));
  assert.equal(r.status, 0, 'a check never gates, even on fail');
  assert.match(r.line, /^CHECK pool-quota fail · 5h 80% left, week 5% left \(week at or under 5%\)/);
  r = pq(quota(0.14, 0.5, [seat('a@x.org', 0.86, 0.5)]));
  assert.match(r.line, /^CHECK pool-quota warn · 5h 14% left, week 50% left \(5h under 15%\)/);
  r = pq(quota(0.15, 0.151, [seat('a@x.org', 0.85, 0.7)]));
  assert.match(r.line, /^CHECK pool-quota ok /, '5h exactly 15% and week just over 15% are ok');
  r = pq(quota(0.8, 0.29, [seat('a@x.org', 0.2, 0.7)]));
  assert.match(r.line, /^CHECK pool-quota ok · 5h 80% left, week 29% left, /, 'the old 30% weekly floor no longer warns (7-day cap 100%)');
});

test('pool-quota: the line names the weekly reset when the proxy reports it, and only a sane one', () => {
  const at = NOW + 2 * 86_400_000;
  const want = new Date(at).toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const body = quota(0.8, 0.12, [seat('a@x.org', 0.2, 0.9)]);
  body.aggregate.weeklyShared.nextResetAt = at;
  let r = pq(body, { TZ: 'UTC' });
  const d = new Date(at);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const mmdd = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  assert.ok(r.line.includes(`week 12% left (week at or under 15%), week resets ${want} ${mmdd} ${hhmm}, seats`), r.line);
  for (const bad of ['soon', -1, 0, 1e20]) {
    body.aggregate.weeklyShared.nextResetAt = bad;
    r = pq(body);
    assert.match(r.line, /^CHECK pool-quota warn · /);
    assert.doesNotMatch(r.line, /resets/, `nextResetAt ${bad} is not printed`);
  }
});

test('pool-quota: a bucket reset more than 15 min ago that still shows usage is stale and warns', () => {
  const stale = seat('old@x.org', 0.4, 0.2);
  stale.buckets.fiveHour.resetAt = NOW - 16 * 60_000;
  const recent = seat('new@x.org', 0.4, 0.2);
  recent.buckets.fiveHour.resetAt = NOW - 10 * 60_000;
  const r = pq(quota(0.8, 0.6, [stale, recent]));
  assert.match(r.line, /^CHECK pool-quota warn · .*\(stale buckets: old\)/);
});

test('pool-quota: seat names cannot carry control characters into the line', () => {
  const r = pq(quota(0.5, 0.5, [seat('\u001b[2J\u001b[Hspoof@x.org', 0.95, 0.1), seat('re\nx@x.org', 0.1, 0.1, { status: 'bad\u0007' })]));
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /[\x00-\x09\x0b-\x1f\x7f]/);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.match(r.line, /seats ≥90% used: \?\?2J\?\?Hspoof, not active: re\?x=bad\?, /);
});

test('pool-quota: disabled seats are ignored; a seat not active is named', () => {
  const r = pq(quota(0.8, 0.6, [seat('off@x.org', 0.99, 0.99, { disabled: true }), seat('re@x.org', 0.1, 0.1, { status: 'needs-reauth' })]));
  assert.match(r.line, /seats ≥90% used: none, not active: re=needs-reauth, /);
});

test('pool-quota: no aggregate, bad JSON or no endpoint is a fail line (exit 0: a check never gates)', () => {
  for (const body of ['{"accounts":[]}', 'not json',
    '{"aggregate":{"fiveHour":{"remaining":0.8},"weeklyShared":{"remaining":0.8}},"accounts":[]}\n{}',
    '{"aggregate":{"fiveHour":{"remaining":0.8},"weeklyShared":{"remaining":0.8}},"accounts":[]}\n{"aggregate":{"fiveHour":{"remaining":0.8},"weeklyShared":{"remaining":0.8}},"accounts":[]}', '{"aggregate":{"fiveHour":{"remaining":"x"},"weeklyShared":{"remaining":0.5}}}']) {
    const r = pq(body);
    assert.equal(r.status, 0, body);
    assert.match(r.line, /^CHECK pool-quota fail · quota endpoint answered without aggregate numbers/);
  }
  const r = run('pool-quota.sh', { CHECK_QUOTA_URL: 'http://127.0.0.1:1/teamclaude/quota' });
  assert.equal(r.status, 0);
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
const OK = 'proxy=200 wrapper=refuses claude=0 direct=0';

test('proxy-wrapper: all forwarders up and every claude fails closed is ok', () => {
  const r = pw({ [SELF]: OK, waki: OK, kat: 'proxy=200 wrapper=envsh-pool claude=0 direct=0' });
  assert.equal(r.status, 0);
  assert.match(r.line, new RegExp(`^CHECK proxy-wrapper ok · ${SELF} :3456 200, wrapper refuses, 0 claude running; waki :3456 200, wrapper refuses, 0 claude running; kat :3456 200, wrapper envsh-pool, 0 claude running, at `));
});

test('proxy-wrapper: another host down or unreachable warns; this host down fails', () => {
  let r = pw({ [SELF]: OK, waki: 'proxy=000 wrapper=refuses claude=0 direct=0' });
  assert.equal(r.status, 0); assert.match(r.line, /^CHECK proxy-wrapper warn · waki forwarder 000 — /);
  r = pw({ [SELF]: OK, waki: '' });
  assert.match(r.line, /^CHECK proxy-wrapper warn · waki unreachable — /);
  r = pw({ [SELF]: 'proxy=502 wrapper=refuses claude=0 direct=0', waki: OK });
  assert.equal(r.status, 0); assert.match(r.line, new RegExp(`^CHECK proxy-wrapper fail · ${SELF} forwarder 502 — `));
});

test('proxy-wrapper: a claude that would run outside the pool warns', () => {
  for (const state of ['envsh-off', 'none']) {
    const r = pw({ [SELF]: OK, waki: `proxy=200 wrapper=${state} claude=0 direct=0` });
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
  const r = pw({ [SELF]: OK, kat: 'proxy=200 wrapper=envsh-bypass claude=0 direct=0' });
  assert.match(r.line, /^CHECK proxy-wrapper warn · kat env\.sh NO_PROXY lets claude skip the pool — /);
});

test('proxy-wrapper: an env.sh that cannot be read without running it warns', () => {
  const r = pw({ [SELF]: OK, kat: 'proxy=200 wrapper=envsh-unverifiable claude=0 direct=0' });
  assert.match(r.line, /^CHECK proxy-wrapper warn · kat env\.sh cannot be read without running it — /);
});

test('proxy-wrapper: a wrapper that is not the reviewed one warns', () => {
  const r = pw({ [SELF]: OK, waki: 'proxy=200 wrapper=wrapper-1b2c3d4e claude=0 direct=0' });
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
const EMPTY_PROC = (() => { const d = join(dir, 'empty-proc'); mkdirSync(d, { recursive: true }); return d; })();
const probe = (h, port, extra = {}, opts = {}) => new Promise((resolve, reject) => {
  execFile('bash', [join(C, 'proxy-probe.sh'), sha(NEW_WRAPPER)], { ...opts, env: { PATH: process.env.PATH, HOME: h, CHECK_PROXY_PORT: String(port), CHECK_PROC: EMPTY_PROC, CHECK_SS: '/bin/true', ...extra }, encoding: 'utf8', timeout: 60_000 },
    (err, stdout) => (err && err.code !== 0 ? reject(err) : resolve(stdout.trim())));
});
const NEW_WRAPPER = readFileSync(join(ROOT, 'scripts', 'claude-wrapper.sh'), 'utf8');
// the pre-#66 wrapper: falls back to the own login when :3456 is down
const OLD_WRAPPER = '#!/bin/sh\nREAL=$(readlink -f "$HOME/.local/bin/claude")\nif [ -z "$TEAMCLAUDE_BYPASS" ] && timeout 2 bash -c \': </dev/tcp/127.0.0.1/3456\' 2>/dev/null; then\n  export HTTPS_PROXY=http://127.0.0.1:3456\nelse\n  echo "[claude] teamclaude tunnel down; using own login" >&2\nfi\nexec "$REAL" "$@"\n';

test('proxy-probe: the reviewed wrapper reads refuses; any other wrapper is named by hash and never run', async () => {
  await withServer(200, async (port) => {
    assert.equal(await probe(home(NEW_WRAPPER), port), 'proxy=200 wrapper=refuses claude=0 direct=0');
    assert.equal(await probe(home(OLD_WRAPPER), port), `proxy=200 wrapper=wrapper-${sha(OLD_WRAPPER).slice(0, 8)} claude=0 direct=0`);
    const rogue = '#!/bin/sh\ntouch "$HOME/probe-ran-me"\nexit 69\n';
    const h = home(rogue);
    assert.equal(await probe(h, port), `proxy=200 wrapper=wrapper-${sha(rogue).slice(0, 8)} claude=0 direct=0`);
    assert.equal(existsSync(join(h, 'probe-ran-me')), false, 'the probe executed the wrapper');
    const nx = home(NEW_WRAPPER); chmodSync(join(nx, '.cargo', 'bin', 'claude'), 0o644);
    assert.equal(await probe(nx, port), 'proxy=200 wrapper=wrapper-notexec claude=0 direct=0', 'a non-executable reviewed wrapper is skipped by PATH');
  });
});

// an env.sh body that settles all four proxy variables first, so the case tests its content
const envs = (body) => home(null, 'unset HTTPS_PROXY https_proxy NO_PROXY no_proxy\n' + body);
test('proxy-probe: katana-style env.sh is judged by where HTTPS_PROXY points', async () => {
  await withServer(200, async (port) => {
    assert.equal(await probe(envs('export HTTPS_PROXY=https://key:key@10.0.6.145:3443\n'), port), 'proxy=200 wrapper=envsh-pool claude=0 direct=0');
    assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:3456\n'), port), 'proxy=200 wrapper=envsh-pool claude=0 direct=0');
    assert.equal(await probe(envs('# cc direct\nunset HTTPS_PROXY\n'), port), 'proxy=200 wrapper=envsh-off claude=0 direct=0');
    assert.equal(await probe(envs('# export HTTPS_PROXY=http://127.0.0.1:3456\n'), port), 'proxy=200 wrapper=envsh-off claude=0 direct=0');
    assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:34560\n'), port), 'proxy=200 wrapper=envsh-off claude=0 direct=0', 'another port');
    assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:3456#x\n'), port), 'proxy=200 wrapper=envsh-off claude=0 direct=0', 'a # touching the value is part of it, as in bash');
    for (const loc of ['C', 'C.UTF-8'])
      assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:3456\u2003\n'), port, { LC_ALL: loc }), 'proxy=200 wrapper=envsh-off claude=0 direct=0', `an EM SPACE stays in the value (${loc})`);
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
      [P + "export NO_PROXY='*anthropic.com'\n", 'envsh-bypass', 'a leading * matches any suffix (Node)'],
      [P + "export NO_PROXY='*:0443'\n", 'envsh-bypass', 'a wildcard with a port'],
      [P + "export NO_PROXY='*.example.org'\n", 'envsh-pool', 'a wildcard for another domain'],
      [P + "export NO_PROXY='api.anthropic.com:80'\n", 'envsh-pool', 'another port does not cover 443'],
      [P + "export NO_PROXY='api.anthropic.com:443'\n", 'envsh-bypass', 'port 443 does'],
      [P + "export NO_PROXY='api.anthropic.com:0443'\n", 'envsh-bypass', '0443 is 443'],
      [P + "export NO_PROXY='api.anthropic.com:18446744073709552059'\n", 'envsh-pool', '2^64+443 is not 443'],
      [P + "export NO_PROXY='api.anthropic.com:0'\n", 'envsh-pool', 'port 0 is not 443'],
      [P + "export NO_PROXY='api.anthropic.com:https'\n", 'envsh-bypass', 'a non-numeric port is read as covering the host'],
      [P + 'export NO_PROXY="api.anthropic.com\vlocalhost"\n', 'envsh-unverifiable', 'a \\v separator'],
      [P + 'export NO_PROXY="localhost\u00a0api.anthropic.com"\n', 'envsh-unverifiable', 'an NBSP separator'],
      [P + "export NO_PROXY='api.anth ropic.com'\n", 'envsh-pool', 'a blank separates entries, never joins them'],
      [P + "export NO_PROXY='localhost claude.ai'\n", 'envsh-bypass', 'a blank-separated list'],
      [P + 'export NO_PROXY=" localhost , *"\n', 'envsh-bypass', 'a spaced * entry'],
      [P + "export NO_PROXY='*'\nunset NO_PROXY\n", 'envsh-pool', 'a later unset clears the bypass'],
      [P + 'export NO_PROXY=localhost,127.0.0.1,10.0.0.0/8,.jphe.in\n', 'envsh-pool', 'a LAN-only NO_PROXY'],
      [P + 'export https_proxy=http://elsewhere:8080\n', 'envsh-off', 'lowercase https_proxy wins in Node and points elsewhere'],
      ['export https_proxy=http://127.0.0.1:3456\n', 'envsh-pool', 'lowercase alone at the pool'],
      ['export HTTPS_PROXY=https://k@x@10.0.6.145:3443\n', 'envsh-off', 'userinfo is token characters only'],
    ]) assert.equal(await probe(envs(body), port), `proxy=200 wrapper=${want} claude=0 direct=0`, why);
    for (const ws of ['\v', '\f'])
      assert.equal(await probe(envs(`export HTTPS_PROXY=http://127.0.0.1:3456${ws}\n`), port), 'proxy=200 wrapper=envsh-off claude=0 direct=0', `a trailing ${JSON.stringify(ws)} stays in the value, as in bash`);
    assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:3456\nunset HTTPS_PROXY\n'), port), 'proxy=200 wrapper=envsh-off claude=0 direct=0', 'a later unset wins');
    assert.equal(await probe(envs('export HTTPS_PROXY=http://127.0.0.1:3456\nexport HTTPS_PROXY=http://elsewhere:1\n'), port), 'proxy=200 wrapper=envsh-off claude=0 direct=0', 'a later export wins');
    assert.equal(await probe(envs('export HTTPS_PROXY=https://k@10.0.6.145:3443.evil\n'), port), 'proxy=200 wrapper=envsh-off claude=0 direct=0', 'anchored host');
    assert.equal(await probe(envs('unset HTTPS_PROXY; exit 0\n'), port), 'proxy=200 wrapper=envsh-unverifiable claude=0 direct=0', 'a compound line is not read');
    const mut = envs('touch "$HOME/probe-ran-envsh"\nexport HTTPS_PROXY=http://127.0.0.1:3456\n');
    assert.equal(await probe(mut, port), 'proxy=200 wrapper=envsh-unverifiable claude=0 direct=0');
    assert.equal(existsSync(join(mut, 'probe-ran-envsh')), false, 'the probe executed env.sh');
    for (const v of ["'http://127.0.0.1:3456'", '"http://127.0.0.1:3456"', 'https://k:k@10.0.6.145:3443 # a comment', 'http://127.0.0.1:3456/'])
      assert.equal(await probe(envs(`export HTTPS_PROXY=${v}\n`), port), 'proxy=200 wrapper=envsh-pool claude=0 direct=0', v);
    for (const body of ["export HTTPS_PROXY='http://127.0.0.1:3456'#$(printf suffix)\n", "export HTTPS_PROXY='http://127.0.0.1:3456'\r\n",
      'export HTTPS_PROXY=$POOL\n', 'export HTTPS_PROXY=http://127.0.0.1:3456\nexport NO_PROXY={example.org,anthropic.com}\n', 'export NO_PROXY=~/x\n', 'export NO_PROXY=*\n', 'if true; then export HTTPS_PROXY=http://127.0.0.1:3456; fi\n', '. ./other.sh\n', 'export HTTPS_PROXY=`cat x`\n'])
      assert.equal(await probe(envs(body), port), 'proxy=200 wrapper=envsh-unverifiable claude=0 direct=0', body);
    const katana = '# Claude Code active backend: teamclaude\nunset CLAUDE_CODE_USE_BEDROCK ANTHROPIC_BASE_URL\nunset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy NODE_EXTRA_CA_CERTS\nexport TITLE=1  # Let shell set title\nexport HTTPS_PROXY=https://k:k@10.0.6.145:3443\nexport NO_PROXY=localhost,127.0.0.1\nexport no_proxy=localhost,127.0.0.1\nexport NODE_EXTRA_CA_CERTS=/home/u/.config/ca.pem\nunset ANTHROPIC_BASE_URL\n';
    assert.equal(await probe(home(null, katana), port), 'proxy=200 wrapper=envsh-pool claude=0 direct=0', 'katana-shaped file');
    assert.equal(await probe(home(null, null), port), 'proxy=200 wrapper=none claude=0 direct=0');
    // the file alone must decide: a variable it neither exports nor unsets comes from the caller
    assert.equal(await probe(home(null, 'export HTTPS_PROXY=http://127.0.0.1:3456\n'), port), 'proxy=200 wrapper=envsh-unverifiable claude=0 direct=0', 'https_proxy/NO_PROXY left to the caller');
    assert.equal(await probe(home(null, 'unset HTTPS_PROXY https_proxy NO_PROXY\nexport HTTPS_PROXY=http://127.0.0.1:3456\n'), port), 'proxy=200 wrapper=envsh-unverifiable claude=0 direct=0', 'no_proxy left to the caller');
    // a * entry must not be expanded as a file name in the probe's working directory
    const cwd = fresh(); writeFileSync(join(cwd, 'ordinary'), '');
    assert.equal(await probe(envs("export HTTPS_PROXY=http://127.0.0.1:3456\nexport NO_PROXY='*'\n"), port, {}, { cwd }), 'proxy=200 wrapper=envsh-bypass claude=0 direct=0', 'glob in cwd');
  });
});

test('proxy-probe: a forwarder that errors or is down reports its code', async () => {
  await withServer(502, async (port) => assert.equal(await probe(home(NEW_WRAPPER), port), 'proxy=502 wrapper=refuses claude=0 direct=0'));
  const srv = createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const { port } = srv.address(); await new Promise((r) => srv.close(r));
  assert.equal(await probe(home(NEW_WRAPPER), port), 'proxy=000 wrapper=refuses claude=0 direct=0');
});

// ---------- fable-use
const fseat = (name, util, resetIn, extra = {}) => ({
  name, type: 'oauth', disabled: false, status: 'active',
  buckets: { weeklyFable: util == null ? undefined : { utilization: util, remaining: 1 - util, resetAt: NOW + resetIn, source: 'unified7dFable' } },
  ...extra,
});
function fu(body) {
  const f = join(fresh(), 'q.json');
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return run('fable-use.sh', { CHECK_QUOTA_FILE: f, CHECK_NOW_MS: String(NOW) });
}
const H = 3_600_000;

test('fable-use: Fable used, or weeks far from their end, is ok and lists every seat by local part', () => {
  const r = fu({ accounts: [fseat('claude3@x.org', 0.4, 2 * H), fseat('b@x.org', 0, 3 * 24 * H)] });
  assert.equal(r.status, 0);
  assert.match(r.line, LINE);
  assert.match(r.line, /^CHECK fable-use ok · Fable week used: pool avg 20% \(claude3 40%, b 0%\), at \d\d:\d\d · next run tomorrow 07:40 · /);
  assert.equal(readFileSync(join(r.state, 'fable-use.line'), 'utf8').trim(), r.line);
});

test('fable-use: a seat whose Fable week ends within 24 h under 1% used warns, naming it', () => {
  const r = fu({ accounts: [fseat('a@x.org', 0, 23 * H), fseat('b@x.org', 0.009, 1 * H), fseat('c@x.org', 0.01, 1 * H), fseat('d@x.org', 0, 25 * H), fseat('e@x.org', 0, -H)] });
  assert.match(r.line, /^CHECK fable-use warn · .*; ending unused within 24 h: a b, at /);
  assert.match(fu({ accounts: [fseat('a@x.org', 0, 24 * H)] }).line, /^CHECK fable-use warn · .*ending unused within 24 h: a,/, 'exactly 24 h counts');
});

test('fable-use: disabled seats are ignored; a seat without a Fable bucket is named but does not warn', () => {
  const r = fu({ accounts: [fseat('a@x.org', 0.5, 2 * H), fseat('off@x.org', 0, H, { disabled: true }), fseat('nob@x.org', null, 0)] });
  assert.match(r.line, /^CHECK fable-use ok · Fable week used: pool avg 50% \(a 50%\), no Fable bucket: nob, at /);
  assert.match(fu({ accounts: [fseat('nob@x.org', null, 0)] }).line, /^CHECK fable-use ok · no seat reports a Fable bucket, no Fable bucket: nob, at /);
});

test('fable-use: seat names cannot carry control characters into the line', () => {
  const r = fu({ accounts: [fseat('ev\nil\u001f\u001bx@x.org', 0, H)] });
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1);
  assert.match(r.line, /ending unused within 24 h: ev\?il\?\?x,/);
});

test('fable-use: no accounts list, bad JSON or no endpoint is a fail line (exit 0)', () => {
  for (const body of ['{}', '{"accounts": 3}', 'not json', '{"accounts": []}\n{"accounts": []}']) {
    const r = fu(body);
    assert.equal(r.status, 0, body);
    assert.match(r.line, /^CHECK fable-use fail · quota endpoint answered without a valid accounts list/, body);
  }
  // xreview round 1: a present but malformed bucket, or a non-object entry, is a fail, never ok
  const bad = (b) => ({ accounts: [fseat('a@x.org', 0.5, H), { name: 'z@x.org', buckets: { weeklyFable: b } }] });
  for (const body of [{ accounts: [null] }, { accounts: [7] }, bad({ utilization: 'broken', resetAt: NOW + H }), bad({ utilization: 0 }),
    bad({ utilization: 0, resetAt: 'broken' }), bad({ utilization: 2, resetAt: NOW + H }), bad({ utilization: -0.1, resetAt: NOW + H }),
    bad({ utilization: 0, resetAt: 0 }), bad('x'), bad([]), bad(false), bad(0)]) {
    const r = fu(body);
    assert.match(r.line, /^CHECK fable-use fail · quota endpoint answered without a valid accounts list/, JSON.stringify(body));
  }
  const r = run('fable-use.sh', { CHECK_QUOTA_URL: 'http://127.0.0.1:1/teamclaude/quota' });
  assert.equal(r.status, 0);
  assert.match(r.line, /^CHECK fable-use fail · quota endpoint http:\/\/127\.0\.0\.1:1\/teamclaude\/quota did not answer/);
});

// ---------- resets-banked
const iso = (ms) => new Date(ms).toISOString();
const rseat = (name, r, spent = 0) => ({ name, resets: r, resetsSpent7d: spent });
const rb = (avail, weeklyBanked, wexpIn, oexpIn, extra = {}) => ({ eligible: true, available: avail, weeklyApplicable: 0, weeklyBanked,
  weeklyBankedExpiresAt: wexpIn == null ? null : iso(NOW + wexpIn), otherExpiresAt: oexpIn == null ? null : iso(NOW + oexpIn),
  expiresAt: iso(NOW + Math.min(...[wexpIn, oexpIn].filter((x) => x != null))), seenAt: iso(NOW - 600_000), ...extra });
function rbk(body) {
  const f = join(fresh(), 'q.json');
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return run('resets-banked.sh', { CHECK_QUOTA_FILE: f, CHECK_NOW_MS: String(NOW) });
}
const D = 86_400_000;

test('resets-banked: splits weekly-clearing from 5h-only with each soonest expiry, and counts spends in 7 days', () => {
  const r = rbk({ seats: [rseat('claude5@x.org', rb(3, 1, 24 * D, 113 * D), 1), rseat('claude3@x.org', rb(2, 0, null, 112 * D), 0)] });
  assert.equal(r.status, 0);
  assert.match(r.line, LINE);
  assert.match(r.line, /^CHECK resets-banked ok · banked: weekly-clearing 1 \(soonest expiry \w{3} \d+\), 5h-only 4 \(soonest expiry \w{3} \d+\); spent in 7 days: 1, at /);
});

test('resets-banked: a reset expiring within 48 h warns naming the seat; an unread seat is named', () => {
  const r = rbk({ seats: [rseat('a@x.org', rb(1, 1, 47 * 3_600_000, null)), rseat('b@x.org', rb(2, 0, null, 49 * 3_600_000)), rseat('c@x.org', null)] });
  assert.match(r.line, /^CHECK resets-banked warn · .*; expiring within 48 h unspent: a, no reading: c, at /);
});

test('resets-banked: no reading anywhere, a malformed reset block, or no endpoint fails (exit 0)', () => {
  assert.match(rbk({ seats: [rseat('a@x.org', null)] }).line, /^CHECK resets-banked fail · no seat has a fresh reset reading/);
  for (const body of ['{}', 'nope', { seats: [7] }, { seats: [rseat('a@x.org', { available: -1, weeklyBanked: 0 })] }, { seats: [rseat('a@x.org', { available: 1, weeklyBanked: 2 })] }, { seats: [rseat('a@x.org', 'x')] }, { seats: [rseat('a@x.org', { available: 1.5, weeklyBanked: 0 })] }]) {
    const r = rbk(body);
    assert.equal(r.status, 0);
    assert.match(r.line, /^CHECK resets-banked fail · quota endpoint answered without a valid seats list/, JSON.stringify(body));
  }
  const r = run('resets-banked.sh', { CHECK_QUOTA_URL: 'http://127.0.0.1:1/teamclaude/quota' });
  assert.match(r.line, /^CHECK resets-banked fail · quota endpoint http:\/\/127\.0\.0\.1:1\/teamclaude\/quota did not answer/);
});

test('resets-banked (xreview 2): readings over 2 h old are stale: named, not counted, warn; all stale fails', () => {
  const r = rbk({ seats: [rseat('a@x.org', rb(3, 1, 20 * D, 90 * D)), rseat('b@x.org', rb(2, 0, null, 90 * D, { seenAt: iso(NOW - 3 * 3_600_000) }))] });
  assert.match(r.line, /^CHECK resets-banked warn · banked: weekly-clearing 1 .*, 5h-only 2 .*; stale over 2 h \(not counted\): b, at /);
  const all = rbk({ seats: [rseat('a@x.org', rb(3, 1, 20 * D, 90 * D, { seenAt: iso(NOW - 8 * 3_600_000) })), rseat('b@x.org', rb(2, 0, null, 90 * D, { seenAt: null }))] });
  assert.match(all.line, /^CHECK resets-banked fail · no seat has a fresh reset reading \(probe down\?\), stale over 2 h: a b, at /);
  assert.match(rbk({ seats: [rseat('a@x.org', rb(3, 1, 20 * D, 90 * D, { seenAt: 'garbage' }))] }).line, /^CHECK resets-banked fail · quota endpoint answered without a valid seats list/);
});

test('resets-banked (xreview): resets false, a malformed expiry, or a proxy without weeklyBanked fails, never ok', () => {
  for (const r of [false, 0, { ...rb(1, 1, D, null), weeklyBankedExpiresAt: 'garbage' }, { ...rb(1, 0, null, D), otherExpiresAt: 7 }, { ...rb(1, 1, D, null), expiresAt: 'garbage' },
    { eligible: true, available: 3, weeklyApplicable: 0, expiresAt: iso(NOW + D) }]) {
    const out = rbk({ seats: [rseat('a@x.org', rb(1, 0, null, 9 * D)), rseat('b@x.org', r)] });
    assert.match(out.line, /^CHECK resets-banked fail · quota endpoint answered without a valid seats list/, JSON.stringify(r));
  }
  assert.match(rbk({ seats: [rseat('a@x.org', { eligible: true, available: 1, weeklyApplicable: 0, weeklyBanked: 0, weeklyBankedExpiresAt: null, otherExpiresAt: null, expiresAt: null, seenAt: iso(NOW - 60_000) })] }).line, /^CHECK resets-banked ok · /, 'null expiries are legitimate');
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
  assert.equal(r.status, 0); assert.match(r.line, /^CHECK forge-keys fail · cannot read the gateway database/);
  r = fk('KEYS|12\nUNKNOWN|0|0\n');
  assert.equal(r.status, 0); assert.match(r.line, /^CHECK forge-keys fail · gateway database answered incompletely/);
  for (const bad of ['UNKNOWN|0|0\nREFUSED|0|0\nEND\n', 'KEYS|1\nEND\n', 'KEYS|1\nUNKNOWN|garbled|1\nREFUSED|0|0\nEND\n',
    'KEYS|1\nUNKNOWN|0|0\nUNKNOWN|5|1\nREFUSED|0|0\nEND\n', 'KEYS|1\nUNKNOWN|0|0\nREFUSED|0|0\nWHAT|x\nEND\n', 'KEYS|1\nUNKNOWN|0|0\nREFUSED|0|0\nOUT|a|b|many\nEND\n']) {
    r = fk(bad);
    assert.equal(r.status, 0, bad); assert.match(r.line, /answered incompletely or malformed/, bad);
  }
});

// ---------- summary
function summary(files, now = Math.floor(Date.now() / 1000)) {
  const d = fresh();
  for (const [name, [line, ageMin]] of Object.entries(files)) {
    const f = join(d, `${name}.line`); writeFileSync(f, `${line}\n`);
    const t = now - ageMin * 60; utimesSync(f, t, t);
  }
  return spawnSync('bash', [join(C, 'summary.sh')], { env: { PATH: process.env.PATH, CHECK_STATE_DIR: d, CHECK_NOW: String(now) }, encoding: 'utf8' });
}

test('summary: silent when every check is ok and fresh', () => {
  const r = summary({ 'pool-quota': ['CHECK pool-quota ok · x · y', 5], 'proxy-wrapper': ['CHECK proxy-wrapper ok · x · y', 5], 'forge-keys': ['CHECK forge-keys ok · x · y', 600], 'fable-use': ['CHECK fable-use ok · x · y', 600], 'resets-banked': ['CHECK resets-banked ok · x · y', 600], 'security-scan': ['CHECK security-scan ok · x · y', 600] });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
});

test('summary: a malformed or multi-line result is a warn, never silence', () => {
  const r = summary({ 'pool-quota': ['CHECK pool-quota ok garbage', 5], 'proxy-wrapper': ['CHECK proxy-wrapper ok · x · y\nCHECK proxy-wrapper fail · z · y', 5], 'forge-keys': ['CHECK forge-keys ok · x · y', 5], 'fable-use': ['CHECK fable-use ok · x · y', 5], 'resets-banked': ['CHECK resets-banked ok · x · y', 5], 'security-scan': ['CHECK security-scan ok · x · y', 5] });
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^CHECK pool-quota warn · last result is malformed/);
  assert.match(lines[1], /^CHECK proxy-wrapper warn · last result is malformed/);
});

test('summary: repeats warn/fail lines, flags a stale result and a missing one', () => {
  const r = summary({ 'pool-quota': ['CHECK pool-quota warn · week 29% · y', 5], 'proxy-wrapper': ['CHECK proxy-wrapper ok · x · y', 11] });
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'CHECK pool-quota warn · week 29% · y');
  assert.match(lines[1], /^CHECK proxy-wrapper warn · last result is 11 min old \(max 10\): timer stopped\? last: ok · x · y/);
  assert.match(lines[2], /^CHECK forge-keys warn · no result yet/);
  assert.match(lines[3], /^CHECK fable-use warn · no result yet/);
  assert.match(lines[4], /^CHECK resets-banked warn · no result yet/);
});

// ---------- lib
test('lib: an unknown status becomes fail (still exit 0); the line file is written; the log keeps history', () => {
  const d = fresh();
  const r = spawnSync('bash', ['-c', `. '${join(C, 'lib.sh')}'; check_emit demo maybe "a fact" "next"`], { env: { ...BASE_ENV, CHECK_STATE_DIR: d }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'CHECK demo fail · bad status from the check itself: a fact · next');
  assert.ok(existsSync(join(d, 'demo.log')));
  assert.equal(readFileSync(join(d, 'demo.line'), 'utf8').trim(), r.stdout.trim());
  assert.equal(existsSync(join(d, 'demo.line.tmp')), false);
});

test('units: every check has a service and a timer; services run the installed copy', () => {
  for (const name of ['pool-quota', 'proxy-wrapper', 'forge-keys', 'fable-use', 'resets-banked', 'forge-models', 'security-scan']) {
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
  for (const f of ['lib.sh', 'pool-quota.sh', 'proxy-probe.sh', 'proxy-wrapper.sh', 'forge-keys.sh', 'fable-use.sh', 'resets-banked.sh', 'summary.sh', 'install.sh', 'forge-models.sh', 'forge-models.mjs', 'forge-direct.json', 'security-scan.sh']) if (!omit.includes(f)) files[`scripts/checks/${f}`] = readFileSync(join(C, f), 'utf8');
  for (const n of ['pool-quota', 'proxy-wrapper', 'forge-keys', 'fable-use', 'resets-banked', 'forge-models', 'security-scan']) for (const ext of ['service', 'timer']) files[`scripts/checks/systemd/teamclaude-check-${n}.${ext}`] = readFileSync(join(C, 'systemd', `teamclaude-check-${n}.${ext}`), 'utf8');
  files['scripts/claude-wrapper.sh'] = NEW_WRAPPER;
  return files;
};
function install(repo, h) {
  const fake = join(fresh(), 'systemctl'); writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${join(h, 'systemctl.log')}'\n[ "$2" = is-active ] && { echo inactive; exit 3; }\nexit 0\n`); chmodSync(fake, 0o755);
  return spawnSync('bash', [join(repo.dir, 'scripts', 'checks', 'install.sh'), repo.head], { cwd: repo.dir, env: { PATH: process.env.PATH, HOME: h, CHECK_SYSTEMCTL: fake }, encoding: 'utf8' });
}

test('install: a complete merged commit is published and its timers enabled', () => {
  const h = fresh(); const r = install(repoAt(payload()), h);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(h, '.local/libexec/teamclaude-checks/claude-wrapper.sh'), 'utf8'), NEW_WRAPPER);
  assert.ok(existsSync(join(h, '.config/systemd/user/teamclaude-check-forge-keys.timer')));
  assert.match(readFileSync(join(h, 'systemctl.log'), 'utf8'), /^--user enable --now teamclaude-check-pool-quota\.timer teamclaude-check-proxy-wrapper\.timer teamclaude-check-forge-keys\.timer teamclaude-check-fable-use\.timer teamclaude-check-resets-banked\.timer teamclaude-check-forge-models\.timer teamclaude-check-security-scan\.timer$/m);
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
  assert.match(r.stderr, /not exactly the check units; nothing installed/);
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
  const fake = join(fresh(), 'systemctl'); writeFileSync(fake, '#!/bin/sh\n[ "$2" = is-active ] && { echo inactive; exit 3; }\nexit 0\n'); chmodSync(fake, 0o755);
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
  assert.match(r.stderr, /not exactly the check units/);
  assert.equal(existsSync(join(h, '.config/systemd/user/unexpected.timer')), false);
  assert.equal(existsSync(join(h, 'systemctl.log')), false);
});

test('install: timers are stopped before publishing and started again after', () => {
  const h = fresh(); const r = install(repoAt(payload()), h);
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(join(h, 'systemctl.log'), 'utf8').trim().split('\n');
  const stop = log.findIndex((l) => l.startsWith('--user stop teamclaude-check-'));
  const reload = log.findIndex((l) => l === '--user daemon-reload');
  assert.ok(stop >= 0 && reload > stop, log.join(' | '));
});

// timers report active until this install stops them (as on a host where the checks run)
const RUNNING = (h) => `case "$2:$3" in stop:*) : > '${join(h, 'stopped')}' ;; is-active:*.timer) if [ -e '${join(h, 'stopped')}' ]; then echo inactive; exit 3; else echo active; exit 0; fi ;; esac`;
function installWith(repo, h, systemctlBody, extraEnv = {}) {
  const fake = join(fresh(), 'systemctl');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${join(h, 'systemctl.log')}'\n${systemctlBody}\n[ "$2" = is-active ] && { echo inactive; exit 3; }\nexit 0\n`); chmodSync(fake, 0o755);
  return spawnSync('bash', [join(repo.dir, 'scripts', 'checks', 'install.sh'), repo.head], { cwd: repo.dir, env: { PATH: process.env.PATH, HOME: h, CHECK_SYSTEMCTL: fake, CHECK_INSTALL_WAIT_STEP: '0', ...extraEnv }, encoding: 'utf8' });
}

test('install: waits for a running check to finish before publishing', () => {
  const h = fresh(); const n = join(h, 'n');
  // the first is-active answers "active", every later one "inactive"
  const r = installWith(repoAt(payload()), h, `case "$2:$3" in is-active:*.service) if [ ! -e '${n}' ]; then : > '${n}'; echo active; exit 0; fi ;; esac`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh')));
});

test('install: a check still running after the wait publishes nothing and restarts the timers', () => {
  const h = fresh();
  const r = installWith(repoAt(payload()), h, RUNNING(h) + '\ncase "$2:$3" in is-active:*.service) echo active; exit 0 ;; esac');
  assert.equal(r.status, 6);
  assert.match(r.stderr, /still running/);
  assert.equal(existsSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh')), false);
  assert.match(readFileSync(join(h, 'systemctl.log'), 'utf8'), /^--user start teamclaude-check-pool-quota\.timer /m);
});

test('install: a failed publish restarts the stopped timers', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  rmSync(join(h, 'systemctl.log'));
  const r = installWith(repoAt(payload()), h, RUNNING(h), { CHECK_INSTALL_FAIL_AT: 'teamclaude-check-proxy-wrapper.timer' });
  assert.equal(r.status, 5, r.stderr);
  const log = readFileSync(join(h, 'systemctl.log'), 'utf8');
  assert.match(log, /^--user stop /m); assert.match(log, /^--user start teamclaude-check-pool-quota\.timer /m);
});

test('forge-keys: an empty models list is unrestricted, never "outside its allowlist"', () => {
  const d = fresh(); const p = join(d, 'psql'); const sql = join(d, 'sql');
  writeFileSync(p, `#!/bin/sh\ncat > '${sql}'\nprintf 'KEYS|1\\nUNKNOWN|0|0\\nREFUSED|0|0\\nEND\\n'\n`); chmodSync(p, 0o755);
  run('forge-keys.sh', { CHECK_FORGE_PSQL: p });
  const out = readFileSync(sql, 'utf8').split("SELECT 'IDLE'")[0];
  assert.match(out, /AND coalesce\(array_length\(t\.models, 1\), 0\) > 0/);
});

test('install: a timer that did not stop refuses the install and is started again', () => {
  const h = fresh();
  const r = installWith(repoAt(payload()), h, 'case "$2:$3" in stop:*) exit 1 ;; is-active:*.timer) echo active; exit 0 ;; esac');
  assert.equal(r.status, 6);
  assert.match(r.stderr, /did not stop; nothing installed/);
  assert.equal(existsSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh')), false);
  assert.match(readFileSync(join(h, 'systemctl.log'), 'utf8'), /^--user start teamclaude-check-pool-quota\.timer /m);
});

test('install: an unexpected failure after the stop (daemon-reload) still starts the timers again', () => {
  const h = fresh();
  const once = join(h, 'reloaded-once');
  const r = installWith(repoAt(payload()), h, RUNNING(h) + `\ncase "$2" in daemon-reload) if [ ! -e '${once}' ]; then : > '${once}'; exit 1; fi ;; esac`);
  assert.notEqual(r.status, 0);
  const log = readFileSync(join(h, 'systemctl.log'), 'utf8').trim().split('\n');
  assert.equal(log[log.length - 1], '--user start teamclaude-check-pool-quota.timer teamclaude-check-proxy-wrapper.timer teamclaude-check-forge-keys.timer teamclaude-check-fable-use.timer teamclaude-check-resets-banked.timer teamclaude-check-forge-models.timer teamclaude-check-security-scan.timer', log.join(' | '));
});

test('install: a second install while one holds the lock is refused', async () => {
  const h = fresh();
  const lock = join(h, '.local/libexec/teamclaude-checks/.install.lock');
  mkdirSync(dirname(lock), { recursive: true });
  const holder = spawn('flock', [lock, '-c', 'sleep 5'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const r = installWith(repoAt(payload()), h, '');
    assert.equal(r.status, 7);
    assert.match(r.stderr, /another install is running/);
    assert.equal(existsSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh')), false);
  } finally { holder.kill(); }
});

test('proxy-probe: counts running claude CLIs and those connected to a public :443 around the pool', async () => {
  const proc = fresh();
  const mk = (pid, exe) => { mkdirSync(join(proc, String(pid))); symlinkSync(exe, join(proc, String(pid), 'exe')); };
  mk(101, '/home/u/.local/share/claude/versions/2.1.325');
  mk(102, '/home/u/.local/share/claude/versions/2.1.325');
  mk(103, '/home/u/.local/share/claude/versions/2.1.325');
  mk(200, '/usr/bin/curl');
  const ssOut = [
    '0 0 127.0.0.1:50000 127.0.0.1:3456 users:(("claude",pid=101,fd=5))',
    '0 0 10.0.6.107:50001 160.79.104.10:443 users:(("claude",pid=102,fd=6))',
    '0 0 10.0.6.107:50002 10.0.6.145:3443 users:(("claude",pid=103,fd=7))',
    '0 0 10.0.6.107:50003 172.20.1.1:443 users:(("claude",pid=101,fd=8))',
    '0 0 10.0.6.107:50007 192.168.1.9:443 users:(("claude",pid=101,fd=10))',
    '0 0 10.0.6.107:50008 10.0.6.11:443 users:(("claude",pid=101,fd=11))',
    '0 0 10.0.6.107:50009 [::ffff:10.0.6.11]:443 users:(("claude",pid=101,fd=12))',
    '0 0 10.0.6.107:50010 169.254.1.1:443 users:(("claude",pid=101,fd=13))',
    '0 0 10.0.6.107:50011 [fe90::1%eth0]:443 users:(("claude",pid=101,fd=14))',
    '0 0 10.0.6.107:50012 [feb0::2]:443 users:(("claude",pid=101,fd=15))',
    '0 0 10.0.6.107:50004 [2606:4700::1]:443 users:(("claude",pid=103,fd=9))',
    '0 0 10.0.6.107:50005 160.79.104.10:8443 users:(("claude",pid=101,fd=9))',
    '0 0 10.0.6.107:50006 93.184.216.34:443 users:(("curl",pid=200,fd=3))',
  ].join('\n');
  const ss = join(fresh(), 'ss'); writeFileSync(ss, `#!/bin/sh\ncat <<'EOF'\n${ssOut}\nEOF\n`); chmodSync(ss, 0o755);
  await withServer(200, async (port) => {
    assert.equal(await probe(home(NEW_WRAPPER), port, { CHECK_PROC: proc, CHECK_SS: ss }), 'proxy=200 wrapper=refuses claude=3 direct=2');
  });
});

test('proxy-wrapper: claude processes connected around the pool warn', () => {
  const r = pw({ [SELF]: 'proxy=200 wrapper=refuses claude=5 direct=2' });
  assert.match(r.line, new RegExp(`^CHECK proxy-wrapper warn · ${SELF} 2 claude processes connected around the pool — ${SELF} :3456 200, wrapper refuses, 5 claude running`));
});

test('install: a systemd state that cannot be read is not "stopped"', () => {
  const h = fresh();
  const r = installWith(repoAt(payload()), h, 'case "$2" in is-active) exit 1 ;; esac');
  assert.equal(r.status, 6);
  assert.match(r.stderr, /cannot read the state of teamclaude-check-pool-quota\.timer \(no answer\)/);
  assert.equal(existsSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh')), false);
});

test('install: a refused install does not start timers that were not running before it', () => {
  const h = fresh();
  const r = installWith(repoAt(payload()), h, 'case "$2:$3" in is-active:*.service) echo active; exit 0 ;; esac');
  assert.equal(r.status, 6);
  assert.doesNotMatch(readFileSync(join(h, 'systemctl.log'), 'utf8'), /^--user start /m);
});

test('install: an unreadable timer state before stopping refuses without stopping anything', () => {
  const h = fresh();
  const r = installWith(repoAt(payload()), h, 'case "$2" in is-active) exit 1 ;; esac');
  assert.equal(r.status, 6);
  assert.doesNotMatch(readFileSync(join(h, 'systemctl.log'), 'utf8'), /^--user stop /m);
});

test('proxy-probe: a failed connection listing reads "unknown", never 0; the check warns', async () => {
  const proc = fresh(); mkdirSync(join(proc, '101')); symlinkSync('/x/claude/versions/2', join(proc, '101', 'exe'));
  await withServer(200, async (port) => {
    assert.equal(await probe(home(NEW_WRAPPER), port, { CHECK_PROC: proc, CHECK_SS: '/bin/false' }), 'proxy=200 wrapper=refuses claude=1 direct=unknown');
  });
  const r = pw({ [SELF]: 'proxy=200 wrapper=refuses claude=1 direct=unknown' });
  assert.match(r.line, new RegExp(`^CHECK proxy-wrapper warn · ${SELF} claude connections could not be read — `));
});

test('install: after a failure, only the timers that were running are running again', () => {
  const h = fresh(); const stopped = join(h, 'stopped');
  // only pool-quota.timer runs before the install; a check stays busy, so the install refuses
  const body = `case "$2:$3" in stop:*) : > '${stopped}' ;; is-active:teamclaude-check-pool-quota.timer) if [ -e '${stopped}' ]; then echo inactive; exit 3; else echo active; exit 0; fi ;; is-active:*.service) echo active; exit 0 ;; esac`;
  const r = installWith(repoAt(payload()), h, body);
  assert.equal(r.status, 6);
  const starts = readFileSync(join(h, 'systemctl.log'), 'utf8').split('\n').filter((l) => l.startsWith('--user start '));
  assert.deepEqual(starts, ['--user start teamclaude-check-pool-quota.timer']);
});

test('install: a partial enable --now failure leaves no timer running that was not before', () => {
  const h = fresh();
  const r = installWith(repoAt(payload()), h, 'case "$2" in enable) exit 1 ;; esac');
  assert.notEqual(r.status, 0);
  const log = readFileSync(join(h, 'systemctl.log'), 'utf8').trim().split('\n');
  const enable = log.findIndex((l) => l.startsWith('--user enable --now '));
  assert.ok(enable >= 0, log.join(' | '));
  // stop all three timers first, then (after the wait) restore the files and reload; none was running before
  assert.equal(log[enable + 1], '--user stop teamclaude-check-pool-quota.timer teamclaude-check-proxy-wrapper.timer teamclaude-check-forge-keys.timer teamclaude-check-fable-use.timer teamclaude-check-resets-banked.timer teamclaude-check-forge-models.timer teamclaude-check-security-scan.timer', log.join(' | '));
  assert.ok(log.slice(enable + 2).includes('--user daemon-reload'), log.join(' | '));
  assert.equal(existsSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh')), false, 'a first install that failed must not leave its files');
  assert.equal(log.slice(enable + 1).some((l) => l.startsWith('--user start ')), false);
});

test('proxy-wrapper: a blank host list is a fail, never an empty ok', () => {
  const r = run('proxy-wrapper.sh', { CHECK_HOSTS: '  ' });
  assert.equal(r.status, 0);
  assert.match(r.line, /^CHECK proxy-wrapper fail · no hosts to probe/);
});

test('proxy-wrapper: every line of the host list is probed; an option-like entry fails', () => {
  const r = pw({ [SELF]: OK, waki: 'proxy=000 wrapper=refuses claude=0 direct=0' });
  assert.match(r.line, /waki forwarder 000/);
  const d = fresh(); const p = join(d, 'probe');
  writeFileSync(p, `#!/bin/sh\necho 'proxy=200 wrapper=refuses claude=0 direct=0'\n`); chmodSync(p, 0o755);
  const multi = run('proxy-wrapper.sh', { CHECK_HOSTS: `${SELF}\nother`, CHECK_PROBE: p });
  assert.match(multi.line, new RegExp(`${SELF} :3456 200.*; other :3456 200`));
  const bad = run('proxy-wrapper.sh', { CHECK_HOSTS: '-oProxyCommand=/bin/true' });
  assert.equal(bad.status, 0); assert.match(bad.line, /^CHECK proxy-wrapper fail · bad host entry/);
});

test('install: a daemon-reload failure after publishing restores the previous files and reloads them', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  const lib = join(h, '.local/libexec/teamclaude-checks/pool-quota.sh');
  const before = readFileSync(lib, 'utf8');
  rmSync(join(h, 'systemctl.log'));
  const changed = payload(); changed['scripts/checks/pool-quota.sh'] = before + '\n# changed\n';
  const n = join(h, 'reloads');
  // the first daemon-reload fails, a later one succeeds; timers were running
  const body = RUNNING(h) + `\ncase "$2" in daemon-reload) if [ ! -e '${n}' ]; then : > '${n}'; exit 1; fi ;; esac`;
  const r = installWith(repoAt(changed), h, body);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /failed after publishing; the previous install is restored/);
  assert.equal(readFileSync(lib, 'utf8'), before, 'the new script stayed after a failed install');
  const log = readFileSync(join(h, 'systemctl.log'), 'utf8').trim().split('\n');
  assert.equal(log.filter((l) => l === '--user daemon-reload').length, 2, log.join(' | '));
  assert.ok(log.lastIndexOf('--user daemon-reload') < log.findIndex((l) => l.startsWith('--user start ')), log.join(' | '));
});

test('install: a $HOME holding | installs normally', () => {
  const h = join(fresh(), 'check|home'); mkdirSync(h);
  const r = install(repoAt(payload()), h);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(h, '.local/libexec/teamclaude-checks/pool-quota.sh')));
  assert.ok(existsSync(join(h, '.config/systemd/user/teamclaude-check-forge-keys.timer')));
});

test('install: after a failed enable --now, timers are stopped and checks waited for before any file is restored', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  rmSync(join(h, 'systemctl.log'));
  const lib = join(h, '.local/libexec/teamclaude-checks/pool-quota.sh');
  const before = readFileSync(lib, 'utf8');
  const changed = payload(); changed['scripts/checks/pool-quota.sh'] = before + '\n# changed\n';
  // after enable, a check is busy once; the restore must come after that wait
  const marker = join(h, 'enabled'); const seen = join(h, 'seen');
  const body = `case "$2:$3" in enable:*) : > '${marker}'; exit 1 ;; is-active:*.service) if [ -e '${marker}' ] && [ ! -e '${seen}' ]; then : > '${seen}'; echo active; exit 0; fi ;; esac`;
  const r = installWith(repoAt(changed), h, body);
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(lib, 'utf8'), before);
  const log = readFileSync(join(h, 'systemctl.log'), 'utf8').trim().split('\n');
  const en = log.findIndex((l) => l.startsWith('--user enable --now '));
  const after = log.slice(en + 1);
  assert.ok(after[0].startsWith('--user stop '), after.join(' | '));
  const waited = after.findIndex((l) => l.startsWith('--user is-active teamclaude-check-'));
  const reload = after.indexOf('--user daemon-reload');
  assert.ok(waited > 0 && reload > waited, after.join(' | '));
});

test('proxy-probe: a byte-identical wrapper under a path with a backslash still reads refuses', async () => {
  const h = join(fresh(), 'odd\\home'); mkdirSync(join(h, '.cargo', 'bin'), { recursive: true });
  writeFileSync(join(h, '.cargo', 'bin', 'claude'), NEW_WRAPPER); chmodSync(join(h, '.cargo', 'bin', 'claude'), 0o755);
  await withServer(200, async (port) => assert.equal(await probe(h, port), 'proxy=200 wrapper=refuses claude=0 direct=0'));
});

test('install: a check that never goes idle during rollback: no file is replaced under it, backups kept, timers stay stopped', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  rmSync(join(h, 'systemctl.log'));
  const lib = join(h, '.local/libexec/teamclaude-checks/pool-quota.sh');
  const before = readFileSync(lib, 'utf8');
  const changed = payload(); changed['scripts/checks/pool-quota.sh'] = before + '\n# changed\n';
  const marker = join(h, 'enabled');
  const body = RUNNING(h) + `\ncase "$2:$3" in enable:*) : > '${marker}'; exit 1 ;; is-active:*.service) if [ -e '${marker}' ]; then echo active; exit 0; fi ;; esac`;
  const r = installWith(repoAt(changed), h, body);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ROLLBACK INCOMPLETE/);
  assert.equal(readFileSync(lib, 'utf8'), before + '\n# changed\n', 'a file was replaced under a running check');
  const keep = r.stderr.match(/previous files in (\S+)/)[1];
  const manifest = readFileSync(join(keep, 'MANIFEST'), 'utf8');
  const idx = manifest.split('\n').find((l) => l.endsWith('/pool-quota.sh')).split('\t')[0];
  assert.equal(readFileSync(join(keep, idx), 'utf8'), before, 'the backup of the previous file is kept');
  assert.doesNotMatch(readFileSync(join(h, 'systemctl.log'), 'utf8').split('--user enable')[1], /^--user start /m);
});

test('install: a timer that does not stop during rollback: no file is replaced, backups kept', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  const lib = join(h, '.local/libexec/teamclaude-checks/pool-quota.sh');
  const before = readFileSync(lib, 'utf8');
  const changed = payload(); changed['scripts/checks/pool-quota.sh'] = before + '\n# changed\n';
  const marker = join(h, 'enabled');
  // enable starts a timer and fails; after that, stop has no effect and the timer reads active
  const body = `case "$2:$3" in enable:*) : > '${marker}'; exit 1 ;; is-active:*.timer) if [ -e '${marker}' ]; then echo active; exit 0; fi ;; esac`;
  const r = installWith(repoAt(changed), h, body);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ROLLBACK INCOMPLETE/);
  assert.equal(readFileSync(lib, 'utf8'), before + '\n# changed\n');
});

test('install: if the backups cannot be moved aside, the staging copy is kept and named', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  const libdir = join(h, '.local/libexec/teamclaude-checks');
  const before = readFileSync(join(libdir, 'pool-quota.sh'), 'utf8');
  const changed = payload(); changed['scripts/checks/pool-quota.sh'] = before + '\n# changed\n';
  const marker = join(h, 'enabled');
  // services stay busy after enable fails; a fake mv refuses to move the rollback directory
  const bin = fresh(); const mv = join(bin, 'mv');
  writeFileSync(mv, `#!/bin/sh\ncase "$*" in *.rollback-*) exit 1 ;; esac\nexec /bin/mv "$@"\n`); chmodSync(mv, 0o755);
  const body = RUNNING(h) + `\ncase "$2:$3" in enable:*) : > '${marker}'; exit 1 ;; is-active:*.service) if [ -e '${marker}' ]; then echo active; exit 0; fi ;; esac`;
  const r = installWith(repoAt(changed), h, body, { PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(r.status, 0);
  const m = r.stderr.match(/previous files in (\S+)/);
  assert.ok(m, r.stderr);
  const manifest = readFileSync(join(m[1], 'MANIFEST'), 'utf8');
  const idx = manifest.split('\n').find((l) => l.endsWith('/pool-quota.sh')).split('\t')[0];
  assert.equal(readFileSync(join(m[1], idx), 'utf8'), before);
});

test('install: a failed reload during rollback starts no timer and says how to finish', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  rmSync(join(h, 'systemctl.log'));
  const lib = join(h, '.local/libexec/teamclaude-checks/pool-quota.sh');
  const before = readFileSync(lib, 'utf8');
  const changed = payload(); changed['scripts/checks/pool-quota.sh'] = before + '\n# changed\n';
  const marker = join(h, 'enabled');
  // the publishing reload works, enable fails, the rollback reload fails; timers were running
  const body = RUNNING(h) + `\ncase "$2" in enable) : > '${marker}'; exit 1 ;; daemon-reload) [ -e '${marker}' ] && exit 1 ;; esac`;
  const r = installWith(repoAt(changed), h, body);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ROLLBACK INCOMPLETE: previous files restored but systemd did not reload them/);
  assert.equal(readFileSync(lib, 'utf8'), before);
  const after = readFileSync(join(h, 'systemctl.log'), 'utf8').split('--user enable --now')[1];
  assert.doesNotMatch(after, /^--user start /m);
});

test('install: a restore that fails partway is reported, keeps the backups and starts no timer', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  rmSync(join(h, 'systemctl.log'));
  const libdir = join(h, '.local/libexec/teamclaude-checks');
  const before = readFileSync(join(libdir, 'summary.sh'), 'utf8');
  const changed = payload(); changed['scripts/checks/summary.sh'] = before + '\n# changed\n';
  // the publishing reload makes one published file read-only, then fails
  const body = RUNNING(h) + `\ncase "$2" in daemon-reload) if [ ! -e '${join(h, 'r1')}' ]; then : > '${join(h, 'r1')}'; chmod 0444 '${join(libdir, 'summary.sh')}'; exit 1; fi ;; esac`;
  const r = installWith(repoAt(changed), h, body);
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ROLLBACK INCOMPLETE: could not restore \S*summary\.sh/);
    const keep = r.stderr.match(/previous files in (\S+)/)[1];
    const idx = readFileSync(join(keep, 'MANIFEST'), 'utf8').split('\n').find((l) => l.endsWith('/summary.sh')).split('\t')[0];
    assert.equal(readFileSync(join(keep, idx), 'utf8'), before);
    assert.doesNotMatch(readFileSync(join(h, 'systemctl.log'), 'utf8').split('--user daemon-reload')[1], /^--user start /m);
  } finally { chmodSync(join(libdir, 'summary.sh'), 0o644); }
});

test('install: a timer restart that fails after a rollback is reported with the retry command', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  const body = RUNNING(h) + '\ncase "$2" in start) exit 1 ;; esac';
  const r = installWith(repoAt(payload()), h, body, { CHECK_INSTALL_FAIL_AT: 'pool-quota.sh' });
  assert.equal(r.status, 5);
  assert.match(r.stderr, /ROLLBACK INCOMPLETE: the previous install is in place but its timers did not start\. Run: systemctl --user start teamclaude-check-pool-quota\.timer teamclaude-check-proxy-wrapper\.timer teamclaude-check-forge-keys\.timer teamclaude-check-fable-use\.timer teamclaude-check-resets-banked\.timer/);
});

test('install: a SIGTERM right after the first move still rolls that file back', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  const libdir = join(h, '.local/libexec/teamclaude-checks');
  const first = join(libdir, 'claude-wrapper.sh');   // the first file published (alphabetical)
  const before = readFileSync(first, 'utf8');
  const changed = payload(); changed['scripts/claude-wrapper.sh'] = NEW_WRAPPER + '\n# changed\n';
  const bin = fresh(); const mv = join(bin, 'mv'); const once = join(bin, 'once');
  writeFileSync(mv, `#!/bin/sh\n/bin/mv "$@" || exit $?\ncase "$*" in *-fT*) if [ ! -e '${once}' ]; then : > '${once}'; kill -TERM $PPID; fi ;; esac\n`); chmodSync(mv, 0o755);
  const r = installWith(repoAt(changed), h, RUNNING(h), { PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(first, 'utf8'), before, 'the file moved before the signal was left new');
});

test('install: a second signal during the rollback does not cut it short', () => {
  const h = fresh();
  assert.equal(install(repoAt(payload()), h).status, 0);
  const libdir = join(h, '.local/libexec/teamclaude-checks');
  const a = join(libdir, 'claude-wrapper.sh'), b = join(libdir, 'forge-keys.sh');   // the first two published
  const beforeA = readFileSync(a, 'utf8'), beforeB = readFileSync(b, 'utf8');
  const changed = payload();
  changed['scripts/claude-wrapper.sh'] = NEW_WRAPPER + '\n# changed\n';
  changed['scripts/checks/forge-keys.sh'] = beforeB + '\n# changed\n';
  const bin = fresh(); const once = join(bin, 'cp-once');
  // the install fails on its third move (an ordinary exit), and a TERM arrives during the first restore
  writeFileSync(join(bin, 'cp'), `#!/bin/sh\n/bin/cp "$@" || exit $?\nif [ "$1" = -p ]; then case "$2" in */old/*) if [ ! -e '${once}' ]; then : > '${once}'; kill -TERM $PPID; fi ;; esac; fi\n`);
  chmodSync(join(bin, 'cp'), 0o755);
  const r = installWith(repoAt(changed), h, RUNNING(h), { PATH: `${bin}:${process.env.PATH}`, CHECK_INSTALL_FAIL_AT: 'lib.sh' });
  assert.notEqual(r.status, 0);
  assert.ok(existsSync(once), 'the second signal was never sent');
  assert.equal(readFileSync(a, 'utf8'), beforeA);
  assert.equal(readFileSync(b, 'utf8'), beforeB, 'the rollback stopped after the second signal');
});

// ---------- forge-models (fixture inputs; JP 2026-11-17 05:03 "comprehensive of all available models")
const FM_NOW = Date.parse('2026-11-17T12:50:00Z');
const FM_CFG = {
  claude: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', group: 'main' }, { id: 'claude-fable-5-2', label: 'Fable 5.2', group: 'main' }],
  speech: [{ id: 'en-US-Ava:DragonHDLatestNeural', label: 'Ava, Dragon HD', kind: 'tts', policy: 'recorded-voice' }, { id: 'azure-stt-en-US', label: 'STT', kind: 'asr', policy: 'first-party' }],
  speechRegions: { tts: 'eastus', stt: 'westus' },
  foundryDirect: [{ deployment: 'gpt-image-1.5', label: 'gpt-image-1.5', kind: 'image' }],
  foundryExpect: { 'gpt-6.1-sol': 'gpt-6.1-sol', 'gpt-5.4-pro': 'gpt-5.4-pro', 'gpt-5.4-pro-1': 'gpt-5.4-pro', 'gpt-image-1.5': 'gpt-image-1.5' },
  foundryBlockedModels: { 'third-party': ['FLUX-1.1-pro'] },
  local: [{ id: 'nomic-embed-text-v1.5', label: 'nomic', kind: 'embedding', host: 'familiar', health: 'http://127.0.0.1:1/' }, { id: 'openwakeword', label: 'oww', kind: 'wake', host: 'familiar', wyoming: 1 }],
  feedStems: { katana: 'local/katana-qwen35-9b', 'familiar-piper-cori': null },
  localUnits: { 'wyoming-piper': 'familiar-piper-cori', 'ollama-embed': 'nomic-embed-text-v1.5', 'wyoming-openwakeword': 'openwakeword' },
  katanaTags: { 'qwen3.5:9b-q4_K_M': 'katana' },
  vault: { nebius: 'x', speech: 'y' },
};
const fmIn = (over = {}) => {
  const ts = new Date(FM_NOW - 60_000).toISOString();
  return {
    registry: [
      { name: 'local/katana-qwen35-9b', provider: 'local', enabled: true, mode: 'chat', upstream: '' },
      { name: 'foundry/gpt-6.1-sol', provider: 'azure', enabled: true, mode: 'chat', upstream: 'azure/gpt-6.1-sol' },
      { name: 'foundry/gpt-5.4-pro', provider: 'azure', enabled: true, mode: 'responses', upstream: 'azure/gpt-5.4-pro' },
      { name: 'nebius/glm-5.3', provider: 'nebius', enabled: true, mode: 'chat', upstream: 'nebius/zai-org/GLM-5.3' },
    ],
    gatewayProbes: { 'local/katana-qwen35-9b': { ok: true }, 'foundry/gpt-6.1-sol': { ok: true }, 'foundry/gpt-5.4-pro': { ok: true }, 'nebius/glm-5.3': { ok: true } },
    feed: { katana: { state: 'idle', ts }, 'familiar-piper-cori': { state: 'idle', ts } },
    claudeCatalog: ['claude-opus-5-5', 'claude-fable-5-2'],
    claudeProbes: { 'claude-opus-5-5': { ok: true, served: ['claude-opus-5-5'], seen: true }, 'claude-fable-5-2': { ok: true, served: ['claude-fable-5-2'], seen: true } },
    foundryProbes: { 'gpt-image-1.5': { ok: true } },
    foundry: [
      { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', status: 'succeeded' }, { id: 'gpt-5.4-pro', model: 'gpt-5.4-pro', status: 'succeeded' },
      { id: 'gpt-5.4-pro-1', model: 'gpt-5.4-pro', status: 'succeeded' }, { id: 'gpt-image-1.5', model: 'gpt-image-1.5', status: 'succeeded' },
      { id: 'claude-opus-5-5', model: 'claude-opus-5-5', status: 'succeeded' }, { id: 'FLUX-1.1-pro', model: 'FLUX-1.1-pro', status: 'succeeded' },
      { id: 'sora-2', model: 'sora-2', status: 'failed' },
    ],
    nebius: ['zai-org/GLM-5.3'],
    speech: { 'en-US-Ava:DragonHDLatestNeural': { ok: true }, 'azure-stt-en-US': { ok: true } },
    units: ['wyoming-piper', 'ollama-embed', 'wyoming-openwakeword', 'teamclaude-check-pool-quota', 'realm-forge-feed', 'sshd'],
    katanaTags: ['qwen3.5:9b-q4_K_M'],
    embedHealth: true,
    wake: ['okay_nabu'],
    ...over,
  };
};
function fm(inputs, extra = {}, cfg = FM_CFG) {
  const d = fresh(); chmodSync(d, 0o700);   // a home writable by no one else (publish refuses otherwise)
  mkdirSync(join(d, 'forge'), { mode: 0o700 }); chmodSync(join(d, 'forge'), 0o700);
  writeFileSync(join(d, 'cfg.json'), JSON.stringify(cfg));
  writeFileSync(join(d, 'in.json'), typeof inputs === 'string' ? inputs : JSON.stringify(inputs));
  const r = run('forge-models.sh', { CHECK_FM_HOME: d, CHECK_FM_CONFIG: join(d, 'cfg.json'), CHECK_FM_INPUTS: join(d, 'in.json'), CHECK_FM_OUT: join(d, 'forge', 'direct.json'), CHECK_FM_NOW_MS: String(FM_NOW), ...extra });
  const out = join(d, 'forge', 'direct.json');
  return { ...r, direct: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

test('forge-models: everything listed and answering is ok; blocked Foundry deployments are counted, a failed one ignored', () => {
  const r = fm(fmIn());
  assert.match(r.line, LINE);
  assert.match(r.line, /^CHECK forge-models ok · 12 listed \(4 gateway, 1 host-feed voices, 7 direct\); every listed model answered; blocked on Foundry: 1 Claude, 1 third-party, at /);
  assert.equal(r.direct.schema, 'forge.direct/v1');
  assert.deepEqual(r.direct.models.map((m) => [m.name, m.route, m.reachable]), [
    ['claude-opus-5-5', 'teamclaude', true], ['claude-fable-5-2', 'teamclaude', true], ['en-US-Ava:DragonHDLatestNeural', 'azure-speech', true],
    ['azure-stt-en-US', 'azure-speech', true], ['gpt-image-1.5', 'foundry-direct', true], ['nomic-embed-text-v1.5', 'local', true], ['openwakeword', 'local', true]]);
  assert.deepEqual(r.direct.blocked, { foundry_claude: 1, foundry_third_party: 1 });
});

test('forge-models: a reachable model that is not listed fails, named by source', () => {
  const i = fmIn({ claudeCatalog: ['claude-opus-5-5', 'claude-fable-5-2', 'claude-opus-6'], nebius: ['zai-org/GLM-5.3', 'zai-org/GLM-6'],
    foundry: [...fmIn().foundry, { id: 'gpt-7', model: 'gpt-7', status: 'succeeded' }], units: [...fmIn().units, 'whisper-large'], katanaTags: ['qwen3.5:9b-q4_K_M', 'llama4:8b'] });
  const r = fm(i);
  assert.match(r.line, /^CHECK forge-models fail · .*reachable but unlisted: claude:claude-opus-6, foundry:gpt-7 \(gpt-7\), nebius:zai-org\/GLM-6, unit:whisper-large, katana:llama4:8b/);
});

// Row 1d742c98 (ubox0-93 2026-11-24 12:0x, Sen's wording "state on the row why they stay unlisted, and the
// check line turns ok or warn with that reason"): a registry row enabled:false with a disabled_reason
// accounts for its upstream; warn, not ok, so it stays in sight. No reason: still unlisted (fail).
test('forge-models: a disabled registry row with a reason accounts for its upstream: warn, the reason quoted', () => {
  const i = fmIn({ nebius: ['zai-org/GLM-5.3', 'deepseek-ai/DeepSeek-V4.1-Flash-1017-fast'],
    foundry: [...fmIn().foundry, { id: 'gpt-7', model: 'gpt-7', status: 'succeeded' }],
    registry: [...fmIn().registry,
      { name: 'nebius/deepseek-v4.1-flash-fast', provider: 'nebius', enabled: false, disabledReason: 'Nebius gives no price for the -fast tier', mode: 'chat', upstream: 'nebius/deepseek-ai/DeepSeek-V4.1-Flash-1017-fast' },
      { name: 'foundry/gpt-7', provider: 'azure', enabled: false, disabledReason: 'preview, no SLA', mode: 'chat', upstream: 'azure/gpt-7' }] });
  const r = fm(i);
  assert.match(r.line, /^CHECK forge-models warn · 12 listed \(4 gateway, /, 'a disabled row is not counted as listed');
  assert.match(r.line, /; unlisted on purpose: foundry:gpt-7 \(preview, no SLA\), nebius:deepseek-ai\/DeepSeek-V4\.1-Flash-1017-fast \(Nebius gives no price for the -fast tier\)/);
  assert.doesNotMatch(r.line, /reachable but unlisted/);
});

test('forge-models: a disabled row with no reason (or a blank one) still leaves its upstream unlisted: fail', () => {
  for (const disabledReason of [undefined, '', '   ']) {
    const i = fmIn({ nebius: ['zai-org/GLM-5.3', 'deepseek-ai/DeepSeek-V4.1-Flash-1017-fast'],
      registry: [...fmIn().registry, { name: 'nebius/deepseek-v4.1-flash-fast', provider: 'nebius', enabled: false, disabledReason, mode: 'chat', upstream: 'nebius/deepseek-ai/DeepSeek-V4.1-Flash-1017-fast' }] });
    const r = fm(i);
    assert.match(r.line, /^CHECK forge-models fail · .*reachable but unlisted: nebius:deepseek-ai\/DeepSeek-V4\.1-Flash-1017-fast/, JSON.stringify(disabledReason));
    assert.doesNotMatch(r.line, /unlisted on purpose/);
  }
});

test('forge-models: a disabled-row reason shaped like a credential is not printed', () => {
  const i = fmIn({ nebius: ['zai-org/GLM-5.3', 'x/m-fast'],
    registry: [...fmIn().registry, { name: 'nebius/m-fast', provider: 'nebius', enabled: false, disabledReason: 'key sk-abcdefghijklmnop1234 revoked', mode: 'chat', upstream: 'nebius/x/m-fast' }] });
  const r = fm(i);
  assert.match(r.line, /unlisted on purpose: nebius:x\/m-fast \(reason not shown\)/);
  assert.doesNotMatch(r.line, /sk-abc/);
});

// xreview #102 round 1 (comment 7148597394): every accounted entry printed; the collection boundary
// tested from raw registry JSON; the reason's own rule.
test('forge-models: every model unlisted on purpose is named with its reason, never "+N more" (eight here)', () => {
  const ids = Array.from({ length: 8 }, (_, k) => `vendor/m${k}-fast`);
  const i = fmIn({ nebius: ['zai-org/GLM-5.3', ...ids],
    registry: [...fmIn().registry, ...ids.map((id, k) => ({ name: `nebius/m${k}`, provider: 'nebius', enabled: false, disabledReason: `no price for tier ${k}`, mode: 'chat', upstream: `nebius/${id}` }))] });
  const r = fm(i);
  assert.match(r.line, /^CHECK forge-models warn · /);
  for (const [k, id] of ids.entries()) assert.ok(r.line.includes(`nebius:${id} (no price for tier ${k})`), `${id} missing: ${r.line}`);
  assert.doesNotMatch(r.line, /more\b/);
});

test('forge-models: the collection boundary reads disabled_reason from the raw registry JSON (forge route show --json)', async () => {
  const { registryRows, judge } = await import(join(C, 'forge-models.mjs'));
  const raw = { ok: true, models: [
    ...fmIn().registry.map(({ name, provider, enabled, mode, upstream }) => ({ name, provider, enabled, mode, upstream, host: 'ubox0', billing_class: 'credit' })),
    { name: 'nebius/dsv4-fast', provider: 'nebius', enabled: false, upstream: 'nebius/deepseek-ai/DeepSeek-V4.1-Flash-1017-fast', disabled_reason: '  no price for the -fast tier  ' },
    { name: 'nebius/odd', provider: 'nebius', enabled: false, upstream: 'nebius/x/odd', disabled_reason: 7 },
    { name: 'nebius/none', provider: 'nebius', enabled: false, upstream: 'nebius/x/none' },
  ] };
  const rows = registryRows(0, raw);
  assert.deepEqual(rows.slice(-3).map((m) => [m.name, m.enabled, m.disabledReason]),
    [['nebius/dsv4-fast', false, 'no price for the -fast tier'], ['nebius/odd', false, ''], ['nebius/none', false, '']], 'trimmed; a non-string or missing reason is none');
  assert.equal(registryRows(1, raw), null, 'a failed command is unreadable');
  assert.equal(registryRows(0, { ...raw, ok: false }), null);
  assert.equal(registryRows(0, { ok: true }), null);
  // and through judge(): the raw field decides the verdict
  const v = judge(FM_CFG, fmIn({ nebius: ['zai-org/GLM-5.3', 'deepseek-ai/DeepSeek-V4.1-Flash-1017-fast', 'x/odd'], registry: rows }), FM_NOW);
  assert.equal(v.state, 'fail', 'x/odd has no usable reason: still unlisted');
  assert.deepEqual(v.accounted, ['nebius:deepseek-ai/DeepSeek-V4.1-Flash-1017-fast (no price for the -fast tier)']);
  assert.deepEqual(v.unlisted, ['nebius:x/odd']);
});

test('forge-models: a reason passes only as a plain sentence; URLs and key shapes print "reason not shown"', async () => {
  const { safeReason } = await import(join(C, 'forge-models.mjs'));
  for (const ok of ['no price for the -fast tier', 'no-price-for-the-fast-tier-yet', 'preview, no SLA (until 2026-12)', 'deepseek-ai/DeepSeek-V4.1-Flash-1017-fast is too costly'])
    assert.equal(safeReason(ok), ok, ok);
  for (const bad of [
    'see https://example.com/pricing',              // a URL
    'token 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b', // 32+ hex (letters and digits)
    'pin 12345678901234567890123456789012',            // 32+ hex of digits only: the hex rule alone sees it
    'blob dGhpcyBpcyBhIHNlY3JldCBrZXkgMTIzNDU2',       // base64 run with letters and digits
    'old key sk-abcdef123456 revoked',               // sk- prefix
    'aws AKIAIOSFODNN7EXAMPLE',                       // AKIA
    'x'.repeat(121),                                  // over the 120 cap
    'quote "this"', 'semi;colon', 'new\nline', '',     // outside the charset, or empty
  ]) assert.equal(safeReason(bad), 'reason not shown', JSON.stringify(bad));
});

test('forge-models: a duplicate Foundry deployment of a listed model is covered, not unlisted', () => {
  const r = fm(fmIn());
  assert.doesNotMatch(r.line, /gpt-5\.4-pro-1/);
});

test('forge-models: a listed model that does not answer, or answers as another model, fails', () => {
  const r = fm(fmIn({ gatewayProbes: { ...fmIn().gatewayProbes, 'nebius/glm-5.3': { ok: false, error: 'upstream' } },
    claudeProbes: { ...fmIn().claudeProbes, 'claude-fable-5-2': { ok: true, served: ['claude-opus-5-5'], seen: true } }, embedHealth: false }));
  assert.match(r.line, /^CHECK forge-models fail · .*didn't answer: nebius\/glm-5\.3 \(upstream\), claude-fable-5-2 \(served as claude-opus-5-5\), nomic-embed-text-v1\.5 \(no answer\)/);
  assert.equal(r.direct.models.find((m) => m.name === 'claude-fable-5-2').reachable, false);
});

test('forge-models: a model that left the seat catalog fails', () => {
  const r = fm(fmIn({ claudeCatalog: ['claude-opus-5-5'] }));
  assert.match(r.line, /^CHECK forge-models fail · .*didn't answer: claude-fable-5-2 \(left the seat catalog\)/);
});

test('forge-models: a registered or direct Foundry deployment that now serves another model is drift (fail)', () => {
  const foundry = fmIn().foundry.map((d) => (d.id === 'gpt-6.1-sol' ? { ...d, model: 'claude-sonnet-5-5' } : d.id === 'gpt-image-1.5' ? { ...d, model: 'FLUX-2' } : d));
  const r = fm(fmIn({ foundry }));
  assert.match(r.line, /^CHECK forge-models fail · .*deployment drift: foundry:gpt-6\.1-sol now serves claude-sonnet-5-5, foundry:gpt-image-1\.5 now serves FLUX-2/);
});

test('forge-models: katana asleep warns and its failed gateway probe is not counted dead', () => {
  const r = fm(fmIn({ feed: { ...fmIn().feed, katana: { state: 'asleep', ts: new Date(FM_NOW - 60_000).toISOString() } },
    gatewayProbes: { ...fmIn().gatewayProbes, 'local/katana-qwen35-9b': { ok: false, error: 'timeout_or_unreachable' } }, katanaTags: null }));
  assert.match(r.line, /^CHECK forge-models warn · .*none of the models probed failed; asleep: katana;/);
});

test('forge-models: an unreadable source (vault locked, az, stale feed) warns and is named, never ok', () => {
  const r = fm(fmIn({ nebius: null, speech: null, foundry: null, feed: { katana: { state: 'idle', ts: '2026-11-16T00:00:00Z' }, 'familiar-piper-cori': null } }));
  assert.match(r.line, /^CHECK forge-models warn · .*not read: host feed katana, host feed familiar-piper-cori, Foundry deployments, Nebius catalog \(vault locked\?\), Azure Speech \(vault locked\?\)/);
  assert.equal(r.direct.models.find((m) => m.name === 'azure-stt-en-US').error, 'not read');
});

test('forge-models: unreadable inputs or a crash is a fail line (exit 0)', () => {
  const r = fm('{not json');
  assert.equal(r.status, 0);
  assert.match(r.line, /^CHECK forge-models fail · check crashed reading its sources \(SyntaxError\), at /);
});


// xreview #89 r1.5/r1.6: no ok with a missing probe or an unread source; coverage by the observed model
test('forge-models: a missing Claude probe fails; katana tags unread (katana awake) warns', () => {
  assert.match(fm(fmIn({ claudeProbes: {} })).line, /^CHECK forge-models fail · .*didn't answer: claude-opus-5-5 \(not probed\), claude-fable-5-2 \(not probed\)/);
  const r = fm(fmIn({ katanaTags: null }));
  assert.match(r.line, /^CHECK forge-models warn · .*none of the models probed failed; not read: katana tags/);
});

test('forge-models: a duplicate deployment that serves another model is unlisted, not covered', () => {
  const foundry = fmIn().foundry.map((d) => (d.id === 'gpt-5.4-pro-1' ? { ...d, model: 'gpt-7' } : d));
  assert.match(fm(fmIn({ foundry })).line, /reachable but unlisted: foundry:gpt-5\.4-pro-1 \(gpt-7\)/);
});

test('forge-models: a third-party model is blocked by what it serves, whatever the deployment is called', () => {
  const foundry = [...fmIn().foundry.filter((d) => d.id !== 'FLUX-1.1-pro'), { id: 'my-images', model: 'FLUX-1.1-pro', status: 'succeeded' }];
  assert.match(fm(fmIn({ foundry })).line, /^CHECK forge-models ok · .*blocked on Foundry: 1 Claude, 1 third-party/);
});

test('forge-models: a Claude probe not seen at the seat proxy, or with no proof at all, fails; verdict and row agree (r2.2)', () => {
  for (const seen of [false, null, undefined]) {
    const r = fm(fmIn({ claudeProbes: { ...fmIn().claudeProbes, 'claude-opus-5-5': { ok: true, served: ['claude-opus-5-5'], seen } } }));
    assert.match(r.line, /^CHECK forge-models fail · .*claude-opus-5-5 \(not seen at the seat proxy\)/, String(seen));
    assert.equal(r.direct.models.find((m) => m.name === 'claude-opus-5-5').reachable, false);
  }
});

test('forge-models: a media deployment that does not answer its probe fails and is not published reachable (r2.4)', () => {
  const r = fm(fmIn({ foundryProbes: { 'gpt-image-1.5': { ok: false, error: 'http 429' } } }));
  assert.match(r.line, /^CHECK forge-models fail · .*foundry:gpt-image-1\.5 \(http 429\)/);
  assert.equal(r.direct.models.find((m) => m.name === 'gpt-image-1.5').error, 'http 429');
  assert.match(fm(fmIn({ foundryProbes: {} })).line, /foundry:gpt-image-1\.5 \(not probed\)/);
});

test('forge-models: a key-shaped provider id never reaches the line or the page (r2.3)', () => {
  const canary = 'skCANARY0123456789abcdefXYZ';
  const r = fm(fmIn({ claudeCatalog: ['claude-opus-5-5', 'claude-fable-5-2', `Bearer sk-${canary}`], nebius: ['zai-org/GLM-5.3', canary],
    foundry: [...fmIn().foundry, { id: `dep-${canary}`, model: `m-${canary}`, status: 'succeeded' }], units: [...fmIn().units, `llama-${canary}`],
    katanaTags: ['qwen3.5:9b-q4_K_M', `qwen-${canary}`],
    claudeProbes: { ...fmIn().claudeProbes, 'claude-fable-5-2': { ok: true, served: [canary.toLowerCase()], seen: true } } }));
  assert.doesNotMatch(r.line, /CANARY|canary/);
  assert.doesNotMatch(JSON.stringify(r.direct), /CANARY|canary/);
  assert.match(r.line, /claude:\(unrecognized id\)/);
  // r3.1: a registry name and an Azure upstream, failing and drifting
  const reg = [...fmIn().registry, { name: `sk-${canary}`, provider: 'nebius', enabled: true, mode: 'chat', upstream: 'nebius/x' },
    { name: 'foundry/x', provider: 'azure', enabled: true, mode: 'chat', upstream: `azure/${canary}` }];
  const r2 = fm(fmIn({ registry: reg, foundry: [...fmIn().foundry, { id: canary, model: 'claude-x', status: 'succeeded' }] }));
  assert.doesNotMatch(r2.line, /CANARY|canary/);
  assert.match(r2.line, /\(unrecognized id\) \(not probed\)/);
});

test('forge-models: a model in the direct list that left the seat catalog is not published reachable', () => {
  const r = fm(fmIn({ claudeCatalog: ['claude-opus-5-5'] }));
  assert.equal(r.direct.models.find((m) => m.name === 'claude-fable-5-2').reachable, false);
});

test('forge-models: a probe error that is not a fixed word never reaches the line or the page', () => {
  const canary = 'sk-CANARY0123456789abcdef';
  const r = fm(fmIn({ gatewayProbes: { ...fmIn().gatewayProbes, 'nebius/glm-5.3': { ok: false, error: `Bearer ${canary}` } },
    claudeProbes: { ...fmIn().claudeProbes, 'claude-opus-5-5': { ok: false, served: [], error: canary } },
    speech: { 'en-US-Ava:DragonHDLatestNeural': { ok: false, error: canary }, 'azure-stt-en-US': { ok: true } } }));
  assert.doesNotMatch(r.line, /CANARY/);
  assert.doesNotMatch(JSON.stringify(r.direct), /CANARY/);
  assert.match(r.line, /nebius\/glm-5\.3 \(no answer\)/);
});

// r1.4: publication never follows a symlink on the path
test('forge-models: direct.json is not written through a symlinked parent, and a symlinked target is replaced, not followed', () => {
  const d = fresh(); const elsewhere = fresh(); chmodSync(d, 0o700);
  writeFileSync(join(d, 'cfg.json'), JSON.stringify(FM_CFG)); writeFileSync(join(d, 'in.json'), JSON.stringify(fmIn()));
  symlinkSync(elsewhere, join(d, 'forge'));
  const env = { CHECK_FM_HOME: d, CHECK_FM_CONFIG: join(d, 'cfg.json'), CHECK_FM_INPUTS: join(d, 'in.json'), CHECK_FM_NOW_MS: String(FM_NOW) };
  let r = run('forge-models.sh', { ...env, CHECK_FM_OUT: join(d, 'forge', 'direct.json') });
  assert.match(r.line, /direct\.json not written \(EPATH\)/);
  assert.equal(existsSync(join(elsewhere, 'direct.json')), false);
  const d2 = fresh(); chmodSync(d2, 0o700); mkdirSync(join(d2, 'forge'), { mode: 0o700 }); chmodSync(join(d2, 'forge'), 0o700);
  writeFileSync(join(elsewhere, 'victim'), 'keep');
  symlinkSync(join(elsewhere, 'victim'), join(d2, 'forge', 'direct.json'));
  r = run('forge-models.sh', { ...env, CHECK_FM_HOME: d2, CHECK_FM_OUT: join(d2, 'forge', 'direct.json') });
  assert.doesNotMatch(r.line, /not written/);
  assert.equal(readFileSync(join(elsewhere, 'victim'), 'utf8'), 'keep');
  assert.equal(JSON.parse(readFileSync(join(d2, 'forge', 'direct.json'), 'utf8')).schema, 'forge.direct/v1');
});

// a real 32×32 RGB PNG, built here (signature, IHDR, IDAT, IEND, each with its CRC); options build CRC-correct
// malformed ones for the negatives
async function fmPng({ w = 32, h = 32, color = 2, extra = null, iend = Buffer.alloc(0), plte = [] } = {}) {
  const { deflateSync, crc32 } = await import('node:zlib');
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ch = { 2: 3, 3: 1 }[color];
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = color;
  const raw = Buffer.alloc(h * (1 + w * ch), 0x40); for (let y = 0; y < h; y++) raw[y * (1 + w * ch)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...(extra ? [chunk(extra, Buffer.alloc(4))] : []), ...plte.map((n) => chunk('PLTE', Buffer.alloc(n, 9))),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', iend)]);
}

test('forge-models: isImage decodes a real PNG and refuses signature-only or broken ones (r7.1)', async () => {
  const { isImage } = await import(join(C, 'forge-models.mjs'));
  const good = await fmPng();
  assert.equal(isImage(good), true);
  assert.equal(isImage(await fmPng({ plte: [48] })), true);   // a valid optional palette (16 entries)
  const flip = (i) => { const b = Buffer.from(good); b[i] ^= 0xff; return b; };
  const bad = [
    Buffer.concat([good.subarray(0, 8), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'), Buffer.alloc(2000, 5)]),   // the round-6 fixture
    good.subarray(0, good.length - 12),                       // no IEND
    flip(20),                                                 // IHDR damaged: CRC fails
    flip(good.length - 20),                                   // IDAT damaged
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 1), Buffer.from([0xff, 0xd9])]),   // a JPEG-shaped blob
    Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.alloc(2000, 1)]),                   // a WebP-shaped blob
    await fmPng({ w: 4, h: 4 }),                              // too small to be an answer
    await fmPng({ color: 3 }),                                // indexed, CRC-correct, no PLTE (r8.2)
    await fmPng({ iend: Buffer.from('x') }),                  // non-empty IEND (r8.2)
    await fmPng({ extra: 'ZZZZ' }),                           // an unknown critical chunk (r8.2)
    await fmPng({ plte: [4] }),                               // PLTE not a multiple of 3 (r9.2)
    await fmPng({ plte: [48, 48] }),                          // two PLTEs (r9.2)
    await fmPng({ plte: [771] }),                             // more than 256 entries (r9.2)
  ];
  for (const [i, b] of bad.entries()) assert.equal(isImage(b), false, `case ${i}`);
});

// a real 16 kHz mono 16-bit PCM WAV of 0.2 s
function fmWav({ rate = 16000, seconds = 0.2 } = {}) {
  const data = Buffer.alloc(Math.round(rate * seconds) * 2, 3);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('forge-models: playableWav accepts a real PCM WAV and refuses broken ones (r4.1)', async () => {
  const { playableWav } = await import(join(C, 'forge-models.mjs'));
  assert.equal(playableWav(fmWav()), true);
  // a streamed WAV as gpt-audio-mini sends it: RIFF and data sizes 0xFFFFFFFF, 24 kHz mono 16-bit
  const streamed = fmWav({ rate: 24000 }); streamed.writeUInt32LE(0xffffffff, 4); streamed.writeUInt32LE(0xffffffff, 40);
  assert.equal(playableWav(streamed), true);
  const halfStream = fmWav(); halfStream.writeUInt32LE(0xffffffff, 40);   // data streamed but RIFF sized: inconsistent
  assert.equal(playableWav(halfStream), false);
  // r8.3: a finite, misaligned data size inside a streamed container (the extra byte makes it fit, so misalignment is the only fault)
  const oddInStream = Buffer.concat([fmWav(), Buffer.from([0])]); oddInStream.writeUInt32LE(0xffffffff, 4); oddInStream.writeUInt32LE(6401, 40);
  assert.equal(playableWav(oddInStream), false);
  const bad = [
    Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), Buffer.alloc(3000, 1)]),   // the round-3 fixture: no size, no chunks
    fmWav({ seconds: 0.01 }),                                                               // too short to be an answer
    (() => { const b = fmWav(); b.writeUInt16LE(3, 20); return b; })(),                    // not PCM
    (() => { const b = fmWav(); b.writeUInt32LE(9_999_999, 40); return b; })(),            // data larger than the file
    (() => { const b = fmWav(); b.write('junk', 12, 'latin1'); return b; })(),             // no fmt chunk
    (() => { const b = fmWav(); b.writeUInt32LE(36, 4); return b; })(),                   // RIFF ends before the audio (r5.1)
    (() => { const b = fmWav(); b.writeUInt32LE(0, 28); return b; })(),                    // byte rate 0 (r5.2)
    (() => { const b = fmWav(); b.writeUInt16LE(0, 32); return b; })(),                    // block align 0 (r5.2)
    (() => { const b = fmWav(); b.writeUInt32LE(b.readUInt32LE(40) - 1, 40); return b; })(), // a partial block (r6)
    Buffer.alloc(0),
  ];
  for (const [i, b] of bad.entries()) assert.equal(playableWav(b), false, `case ${i}`);
});

// ---------- forge-models collect(): fake binaries and a local HTTP server (r1.7)
async function fmCollect({ deployments, bwStatus = 'unlocked', claudeCounts = true, regions = { tts: 'eastus', stt: 'westus' }, gatewayError = null, foundryStatus = 200, audio = null, image = null, wyomingPort = null, tts = null, ca = true, extraEnv = {}, vendors = null, vaultList = null } = {}) {
  const d = fresh(); const bin = join(d, 'bin'); const log = join(d, 'calls.log'); const counter = join(d, 'counter');
  chmodSync(d, 0o700); mkdirSync(bin); writeFileSync(log, ''); writeFileSync(counter, '0');
  mkdirSync(join(d, 'forge', 'hosts'), { recursive: true, mode: 0o700 }); chmodSync(join(d, 'forge'), 0o700);
  mkdirSync(join(d, '.config/teamclaude-client'), { recursive: true });
  const key = 'tc-' + 'a'.repeat(48);
  writeFileSync(join(d, '.config/teamclaude-client/forge-check.settings.json'), JSON.stringify({ env: { HTTPS_PROXY: `http://${key}:${key}@127.0.0.1:3456` } }), { mode: 0o600 });
  chmodSync(join(d, '.config'), 0o700);
  const caPath = join(d, '.config/teamclaude-ca.pem'), pem = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n';
  if (ca === true) writeFileSync(caPath, pem, { mode: 0o644 });
  else if (ca === 'empty') writeFileSync(caPath, '', { mode: 0o644 });
  else if (ca === 'dir') mkdirSync(caPath);
  else if (ca === 'group-writable') { writeFileSync(caPath, pem); chmodSync(caPath, 0o664); }
  else if (ca === 'symlink') { writeFileSync(join(d, 'other.pem'), pem); symlinkSync(join(d, 'other.pem'), caPath); }
  else if (ca === 'open-dir') { writeFileSync(caPath, pem, { mode: 0o644 }); chmodSync(join(d, '.config'), 0o777); }
  const hits = [], vendorHeaders = [], stolen = [], vendorDrops = { n: 0 };
  const png = await fmPng();
  const thief = createServer((q, s) => { stolen.push(q.headers); s.end('{"models":[{"id":"x"}]}'); });
  await new Promise((r) => thief.listen(0, '127.0.0.1', r));
  const redirectTo = `http://127.0.0.1:${thief.address().port}`;
  const srv = createServer((q, s) => {
    hits.push(q.url);
    if (q.url.startsWith('/vendor')) vendorHeaders.push({ ...q.headers, method: q.method });
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => {
      if (q.url.startsWith('/foundry/openai/v1/images')) return s.end(image ?? JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
      if (q.url.startsWith('/foundry/openai/deployments/')) {
        const wav = fmWav().toString('base64');
        return s.end(audio ?? JSON.stringify({ choices: [{ message: { audio: { data: wav } } }] }));
      }
      if (q.url.startsWith('/foundry')) { s.statusCode = foundryStatus; return s.end(JSON.stringify({ data: deployments })); }
      if (q.url.startsWith('/nebius')) return s.end(JSON.stringify({ data: [{ id: 'zai-org/GLM-5.3' }] }));
      if (q.url.startsWith('/tts')) return s.end(tts ?? fmWav());
      if (q.url.startsWith('/stt')) return s.end(JSON.stringify({ RecognitionStatus: 'Success', DisplayText: 'The forge is lit.' }));
      if (q.url.startsWith('/katana')) return s.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b-q4_K_M' }] }));
      if (q.url.startsWith('/health')) return s.end('{"status":"ok"}');
      const sent = Object.values(q.headers).join(' ');
      const badKey = !/(^| )(Bearer |Key )?(testkey123|tokentokentokentokentoken0123)( |$)/.test(sent);   // only the real credential is accepted
      if (q.url.startsWith('/vendor-any')) return s.end(JSON.stringify({ models: [{ id: 'm' }] }));   // answers anyone: not an instrument
      if (q.url.startsWith('/vendor-shape')) { if (/forge-models-invalid-key/.test(sent)) { s.statusCode = 400; return s.end('{}'); } return s.end(JSON.stringify({ models: [{ id: 'm' }] })); }   // checks format only (r2.1)
      if (q.url.startsWith('/vendor-drop')) { if (badKey && vendorDrops.n++ < (q.url.startsWith('/vendor-drop-once') ? 1 : 1e9)) return s.destroy(); }   // a reset, not an answer
      if (badKey) { s.statusCode = 401; return s.end('{}'); }
      if (q.url.startsWith('/vendor-401')) { s.statusCode = 401; return s.end('{"error":"Bearer sk-CANARY77 rejected"}'); }
      if (q.url.startsWith('/vendor-obj')) return s.end(JSON.stringify({ choices: {}, transcripts: {} }));
      if (q.url.startsWith('/vendor-redirect')) { s.statusCode = 302; s.setHeader('Location', `${redirectTo}/stolen`); return s.end(); }
      if (q.url.startsWith('/vendor')) return s.end(JSON.stringify({ transcripts: [], choices: [{ message: { content: 'ok' } }] }));
      s.statusCode = 404; s.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const sh = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const registry = { ok: true, models: [
    { name: 'foundry/gpt-6.1-sol', provider: 'azure', enabled: true, upstream: 'azure/gpt-6.1-sol' },
    { name: 'nebius/glm-5.3', provider: 'nebius', enabled: true, upstream: 'nebius/zai-org/GLM-5.3' } ] };
  sh('forge', `case "$1" in route) echo '${JSON.stringify(registry)}';; probe) ${gatewayError ? `echo '{"ok":false,"error":"${gatewayError}"}'` : `echo '{"ok":true}'`};; esac`);
  sh('az', `echo tokentokentokentokentoken0123`);
  if (vaultList) writeFileSync(join(d, 'vault.json'), JSON.stringify(vaultList));
  sh('bw', `case "$1" in status) echo '{"status":"${bwStatus}"}';; get) echo testkey123;; list) ${vaultList ? `cat '${join(d, 'vault.json')}'` : 'exit 1'};; *) exit 1;; esac`);
  const bump = claudeCounts === true ? `n=$(cat '${counter}'); echo $((n+1)) > '${counter}'`
    : claudeCounts === 'twice-then-none' ? `case "$*" in *claude-opus-5-5*) n=$(cat '${counter}'); echo $((n+2)) > '${counter}';; esac` : ':';
  // like the real one under a systemd unit: without the proxy's CA it cannot fetch the org settings
  sh('claude', `${bump}; echo "claude-env ca=\${NODE_EXTRA_CA_CERTS:-none} session=\${CLAUDE_CODE_SESSION_ID:-none} leaked=\${CLAUDE_EFFORT:-}\${NODE_OPTIONS:-}\${NODE_TLS_REJECT_UNAUTHORIZED:-}\${SSL_CERT_FILE:-}\${SSL_CERT_DIR:-}." >> '${log}'
[ "\$NODE_EXTRA_CA_CERTS" = '${join(d, '.config/teamclaude-ca.pem')}' ] && [ -s "\$NODE_EXTRA_CA_CERTS" ] || { echo '{"is_error":true,"result":"could not connect"}'; exit 1; }
for a; do case "$prev" in --model) m=$a;; esac; prev=$a; done; echo "{\\"is_error\\":false,\\"modelUsage\\":{\\"$m\\":{}}}"`);
  sh('curl', `case "$*" in *model_selector*) echo '{"model_selector_config":[{"models":[{"id":"claude-opus-5-5"},{"id":"claude-fable-5-2"}]}]}';; *status*) echo "{\\"clients\\":{\\"forge-check\\":{\\"requests\\":$(cat '${counter}')}}}";; *) exit 22;; esac`);
  sh('systemctl', `echo "wyoming-piper.service loaded active running x"`);
  sh('docker', `echo wyoming-openwakeword`);
  const cfg = { ...FM_CFG, speechRegions: regions, local: [{ ...FM_CFG.local[0], health: `${base}/health` }, { ...FM_CFG.local[1], wyoming: wyomingPort ?? FM_CFG.local[1].wyoming }],
    foundryDirect: [...FM_CFG.foundryDirect, ...(deployments.some((x) => x.id === 'gpt-audio-mini') ? [{ deployment: 'gpt-audio-mini', label: 'audio', kind: 'audio' }] : [])],
    foundryExpect: { ...FM_CFG.foundryExpect, 'gpt-audio-mini': 'gpt-audio-mini' },
    ...(vendors ? { vendors: vendors(base), vendorScan: { patterns: ['assemblyai', 'deepgram'], accountedPatterns: {}, accountedNames: {} } } : {}) };
  writeFileSync(join(d, 'cfg.json'), JSON.stringify(cfg));
  const urls = { foundryApi: `${base}/foundry/list`, foundryBase: `${base}/foundry`, nebius: `${base}/nebius`, tts: `${base}/tts`, stt: `${base}/stt`, katana: `${base}/katana`, status: 'http://127.0.0.1:3456/teamclaude/status' };
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: d, CHECK_FM_HOME: d, CHECK_FM_PLAN: join(d, 'forge'), CHECK_FM_CONFIG: join(d, 'cfg.json'),
    CHECK_FM_URLS: JSON.stringify(urls), CHECK_FM_PACE_MS: '0', CHECK_FM_OUT: join(d, 'forge', 'direct.json'), CHECK_FM_NOW_MS: String(FM_NOW), ...extraEnv };
  const out = await new Promise((res) => execFile('node', [join(C, 'forge-models.mjs')], { env, encoding: 'utf8', timeout: 60_000 }, (e, so) => res(so)));
  srv.close(); thief.close();
  return { out, calls: readFileSync(log, 'utf8'), hits, vendorHeaders, stolen, direct: existsSync(join(d, 'forge', 'direct.json')) ? JSON.parse(readFileSync(join(d, 'forge', 'direct.json'), 'utf8')) : null };
}
const DEPLOYS = [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', status: 'succeeded' }, { id: 'gpt-image-1.5', model: 'gpt-image-1.5', status: 'succeeded' }];

test('forge-models collect: a Foundry deployment that drifted to Claude is never probed, and fails as drift', async () => {
  const r = await fmCollect({ deployments: [{ id: 'gpt-6.1-sol', model: 'claude-opus-5-5', status: 'succeeded' }, DEPLOYS[1]] });
  assert.doesNotMatch(r.calls, /forge probe foundry\/gpt-6\.1-sol/);
  assert.match(r.calls, /forge probe nebius\/glm-5\.3/);
  assert.match(r.out, /^fail\t.*deployment drift: foundry:gpt-6\.1-sol now serves claude-opus-5-5/);
});

test('forge-models collect: Foundry deployments unread means no Foundry route is probed', async () => {
  const r = await fmCollect({ deployments: DEPLOYS, foundryStatus: 500 });
  assert.doesNotMatch(r.calls, /forge probe foundry\//);
  assert.match(r.out, /not read: .*Foundry deployments/);
});

test('forge-models collect: a healthy run probes every route and Claude model through the seat proxy', async () => {
  const r = await fmCollect({ deployments: DEPLOYS });
  assert.match(r.calls, /forge probe foundry\/gpt-6\.1-sol/);
  assert.match(r.calls, /claude -p --settings .*forge-check\.settings\.json .*--model claude-opus-5-5/);
  assert.match(r.calls, /bw get password x --nointeraction/);
  assert.doesNotMatch(r.out, /not seen at the seat proxy/);
});

test('forge-models collect: a locked vault is never asked for a secret, and its sources are "not read"', async () => {
  const r = await fmCollect({ deployments: DEPLOYS, bwStatus: 'locked' });
  assert.match(r.calls, /bw status --nointeraction/);
  assert.doesNotMatch(r.calls, /bw (get|unlock|login)/);
  assert.match(r.out, /not read: .*Nebius catalog \(vault locked\?\), Azure Speech \(vault locked\?\)/);
});

test('forge-models collect: Claude probes that do not show at the proxy under forge-check fail', async () => {
  const r = await fmCollect({ deployments: DEPLOYS, claudeCounts: false });
  assert.match(r.out, /^fail\t.*claude-opus-5-5 \(not seen at the seat proxy\), claude-fable-5-2 \(not seen at the seat proxy\)/);
});

test('forge-models collect: a Speech region that is not a hostname label sends no request', async () => {
  const r = await fmCollect({ deployments: DEPLOYS, regions: { tts: 'evil.example/x', stt: 'westus' } });
  assert.equal(r.hits.some((h) => h.startsWith('/tts') || h.startsWith('/stt')), false);
  assert.match(r.out, /not read: .*Azure Speech/);
});

test('forge-models collect: Claude probes carry the seat CA and none of the calling session (2026-11-17 timer run)', async () => {
  // these reach the check's own node too, so the --require target must exist (it is empty)
  const hook = join(fresh(), 'noop.cjs'); writeFileSync(hook, '');
  const r = await fmCollect({ deployments: DEPLOYS, extraEnv: { NODE_EXTRA_CA_CERTS: '/etc/elsewhere.pem', CLAUDE_CODE_SESSION_ID: 'caller-session',
    CLAUDE_EFFORT: 'x', NODE_OPTIONS: `--require=${hook}`, NODE_TLS_REJECT_UNAUTHORIZED: '0', SSL_CERT_FILE: '/x.pem', SSL_CERT_DIR: '/x' } });
  assert.match(r.calls, /claude-env ca=\S*\/\.config\/teamclaude-ca\.pem session=none leaked=\./);
  assert.doesNotMatch(r.calls, /caller-session|elsewhere\.pem/);
  assert.doesNotMatch(r.out, /claude-opus-5-5 \(error\)/);
});

test('forge-models collect: a seat CA that is missing or replaceable is named, and no Claude probe is sent (r1.2)', async () => {
  for (const ca of [false, 'empty', 'dir', 'group-writable', 'symlink', 'open-dir']) {
    const r = await fmCollect({ deployments: DEPLOYS, ca });
    assert.doesNotMatch(r.calls, /claude -p/, `ca=${ca}`);
    assert.match(r.out, /^fail\t.*claude-opus-5-5 \(seat CA missing\)/, `ca=${ca}`);
  }
});

test('forge-models collect: a gateway error text is reduced to a fixed word', async () => {
  const r = await fmCollect({ deployments: DEPLOYS, gatewayError: 'Bearer sk-CANARY99' });
  assert.doesNotMatch(r.out, /CANARY/);
  assert.match(r.out, /nebius\/glm-5\.3 \(no answer\)/);
});

// ---------- forge-models AI vendors (JP 07:43 via Sen, plan-chat 2414: "The forge is missing assembly ai?")
const FM_VCFG = { ...FM_CFG,
  vendors: [
    { id: 'assemblyai', label: 'AssemblyAI', provider: 'AssemblyAI', modality: ['stt'], tier: 'credit', policy: 'vendor-direct', vault: 'assemblyai-api-key', instrument: 'list transcripts',
      probe: { url: 'https://api.assemblyai.com/v2/transcript?limit=1', header: 'authorization', scheme: '', expect: 'transcripts', allowEmpty: true } },
    { id: 'ibm-bob', label: 'IBM Bob', provider: 'IBM', modality: ['llm'], policy: 'vendor-direct', vault: 'IBM Bob API key', probe: null, why: 'no free read-only call is known' },
  ],
  vendorScan: { patterns: ['assemblyai', '\\bbob\\b', 'deepgram', 'claude', 'openai'], accountedPatterns: { '^teamclaude[ -]': 'teamclaude proxy credentials' },
    accountedNames: { 'web login, no API key': ['auth.openai.com'] } },
  vendorsWithoutKey: [{ vendor: 'Deepgram', status: 'no key in the vault' }],
};
const FM_VAULT = [{ name: 'assemblyai-api-key', hosts: ['www.assemblyai.com'] }, { name: 'IBM Bob API key', hosts: [] }, { name: 'teamclaude client key ha', hosts: [] },
  { name: 'auth.openai.com', hosts: ['auth.openai.com'] }, { name: 'resend.com api key', hosts: ['resend.com'] }];
const fmV = (over = {}) => fmIn({ vaultItems: FM_VAULT, vendorProbes: { assemblyai: { ok: true } }, ...over });

test('forge-models vendors: every AI vault item accounted for and every vendor key answering is ok; AssemblyAI is the first row', () => {
  const r = fm(fmV(), {}, FM_VCFG);
  assert.match(r.line, /^CHECK forge-models ok · 12 listed \(4 gateway, 1 host-feed voices, 7 direct\); 2 vendor keys \(1 probed\); every listed model answered/);
  const [a, b] = r.direct.models;
  assert.deepEqual([a.name, a.route, a.reachable, a.vault, a.modality, a.policy], ['assemblyai', 'vendor', true, 'assemblyai-api-key', ['stt'], 'vendor-direct']);
  assert.deepEqual([b.name, b.reachable, b.instrument], ['ibm-bob', null, 'none']);
  assert.match(b.error, /^not probed: no free read-only call/);
  assert.deepEqual(r.direct.vendorsWithoutKey, [{ vendor: 'Deepgram', status: 'no key in the vault' }]);
  assert.deepEqual(r.direct.vaultAccounted, [{ why: 'web login, no API key', names: ['auth.openai.com'] }, { why: 'teamclaude proxy credentials', count: 1 }]);
});

test('forge-models vendors: an AI key in the vault that the Forge does not list fails, matched by name or by host', () => {
  const r = fm(fmV({ vaultItems: [...FM_VAULT, { name: 'deepgram api key', hosts: [] }, { name: 'speech thing', hosts: ['console.deepgram.com'] }] }), {}, FM_VCFG);
  assert.match(r.line, /^CHECK forge-models fail · .*reachable but unlisted: vault:deepgram api key, vault:speech thing/);
  // the same item before the vendor row existed: AssemblyAI unlisted is exactly JP's 07:43 question
  const cfg = { ...FM_VCFG, vendors: FM_VCFG.vendors.slice(1) };
  assert.match(fm(fmV(), {}, cfg).line, /reachable but unlisted: vault:assemblyai-api-key/);
});

test('forge-models vendors: a key that does not answer fails with a fixed word; a vendor error text never reaches the line', () => {
  assert.match(fm(fmV({ vendorProbes: { assemblyai: { ok: false, error: 'http 401' } } }), {}, FM_VCFG).line, /^CHECK forge-models fail · .*didn't answer: assemblyai \(http 401\)/);
  const r = fm(fmV({ vendorProbes: { assemblyai: { ok: false, error: 'Bearer sk-CANARY55' } } }), {}, FM_VCFG);
  assert.doesNotMatch(r.line + JSON.stringify(r.direct), /CANARY/);
  assert.match(r.line, /assemblyai \(no answer\)/);
  assert.match(fm(fmV({ vendorProbes: {} }), {}, FM_VCFG).line, /assemblyai \(not probed\)/);
});

test('forge-models vendors: a locked vault warns (not read), it does not fail every vendor', () => {
  const r = fm(fmV({ vaultItems: null, vendorProbes: { assemblyai: { ok: false, error: 'vault locked' } } }), {}, FM_VCFG);
  assert.match(r.line, /^CHECK forge-models warn · .*not read: vault item list \(vault locked\?\), vendor keys \(vault locked\?\)/);
});

test('forge-models vendors: a vault name shaped like a credential is not printed (long, prefixed, short, or split by punctuation)', () => {
  const canaries = ['openai sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'openai sk-abcdefghijklmnopqrstuv', 'openai key abcd1234efgh5678ijkl', 'openai nvapi-q9w8e7r6t5'];
  const r = fm(fmV({ vaultItems: [...FM_VAULT, ...canaries.map((name) => ({ name, hosts: [] }))] }), {}, FM_VCFG);
  assert.match(r.line, /vault:\(unrecognized name\)/);
  for (const c of canaries) assert.ok(!(r.line + JSON.stringify(r.direct)).includes(c.split(' ').pop()), c);
});

test('forge-models vendors: vendorSpec takes https only (no credentials in the URL), a plain header, a known scheme and shape', async () => {
  const { vendorSpec } = await import(join(C, 'forge-models.mjs'));
  const ok = { url: 'https://api.example.com/v1/models', header: 'Authorization', scheme: 'Bearer ', expect: 'data' };
  assert.ok(vendorSpec(ok));
  for (const bad of [{ url: 'http://api.example.com/x' }, { url: 'https://u:p@api.example.com/x' }, { url: 'file:///etc/passwd' }, { header: 'X\r\nInjected: 1' },
    { header: '' }, { scheme: 'Basic ' }, { expect: 'a.b' }, { expect: '' }, { body: 'raw' }, { url: 'not a url' }])
    assert.equal(vendorSpec({ ...ok, ...bad }), null, JSON.stringify(bad));
  // the az login's Entra token: a Cognitive Services host only, as a bearer
  const en = { url: 'https://inner-auth-resource.cognitiveservices.azure.com/openai/deployments', header: 'Authorization', scheme: 'Bearer ', expect: 'data', auth: 'entra' };
  assert.equal(vendorSpec(en)?.auth, 'entra');
  for (const bad of [{ url: 'https://api.example.com/x' }, { url: 'https://cognitiveservices.azure.com.evil.example/x' }, { header: 'api-key', scheme: '' }, { scheme: 'Key ' }, { auth: 'other' }])
    assert.equal(vendorSpec({ ...en, ...bad }), null, JSON.stringify(bad));
});

test('forge-models collect: vendor keys go in the configured header only, never argv; the vault list keeps names, not passwords', async () => {
  const vaultList = [
    { type: 1, name: 'assemblyai-api-key', login: { password: 'PW-SECRET-1', uris: [{ uri: 'https://www.assemblyai.com/app' }] } },
    { type: 1, name: 'deepgram login', login: { password: '', uris: [] } },   // no password: not a key
    { type: 2, name: 'deepgram note', notes: 'x' },
  ];
  const vendors = (base) => [
    { id: 'assemblyai', label: 'AssemblyAI', provider: 'AssemblyAI', modality: ['stt'], policy: 'vendor-direct', vault: 'assemblyai-api-key', instrument: 'x',
      probe: { url: `${base}/vendor/transcript`, header: 'authorization', scheme: '', expect: 'transcripts', allowEmpty: true } },
    { id: 'nv', label: 'NV', provider: 'NVIDIA', modality: ['llm'], policy: 'vendor-direct', vault: 'assemblyai-api-key', instrument: 'x',
      probe: { url: `${base}/vendor-401`, header: 'Authorization', scheme: 'Bearer ', expect: 'choices', body: { model: 'm', max_tokens: 2 } } },
    { id: 'fd', label: 'FD', provider: 'Azure AI Foundry', modality: ['llm'], policy: 'foundry-first-party', instrument: 'x',
      probe: { url: `${base}/vendor/entra`, header: 'Authorization', scheme: 'Bearer ', expect: 'transcripts', allowEmpty: true, auth: 'entra' } },
  ];
  const r = await fmCollect({ deployments: DEPLOYS, vendors, vaultList });
  const real = (h) => /(^| )(Bearer |Key )?(testkey123|tokentokentokentokentoken0123)$/.test(String(h.authorization ?? h['x-api-key'] ?? ''));
  assert.equal(r.vendorHeaders.filter(real)[0].authorization, 'testkey123');
  assert.equal(r.vendorHeaders.filter((h) => !real(h)).length, 3, 'one invalid-credential control per vendor');
  assert.equal(r.vendorHeaders.filter((h) => h.method === 'POST' && real(h)).length, 1, 'a failed POST is never retried (r1.2)');
  assert.equal(r.vendorHeaders.find((h) => h.method === 'POST' && real(h)).authorization, 'Bearer testkey123');
  assert.equal(r.vendorHeaders.filter((h) => h.authorization === 'Bearer tokentokentokentokentoken0123').length, 1);   // the Entra row, and only it
  const fd = r.direct.models.find((m) => m.name === 'fd');
  assert.deepEqual([fd.reachable, fd.auth, fd.vault], [true, 'entra', undefined]);
  assert.doesNotMatch(r.calls, /testkey123|PW-SECRET/);
  assert.match(r.calls, /bw list items --nointeraction/);
  assert.match(r.out, /nv \(http 401\)/);
  assert.doesNotMatch(r.out, /CANARY|unlisted: .*vault:/);
  assert.doesNotMatch(JSON.stringify(r.direct), /PW-SECRET|testkey123/);
  assert.equal(r.direct.models[0].reachable, true);
});

test('forge-models collect: an endpoint that answers any key, a wrong shape, and a redirect are all refused (r1.3, r1.6)', async () => {
  const vaultList = [{ type: 1, name: 'assemblyai-api-key', login: { password: 'PW-SECRET-3', uris: [] } }];
  const mk = (id, path, method) => ({ id, label: id, provider: 'p', modality: ['llm'], policy: 'vendor-direct', vault: 'assemblyai-api-key', instrument: 'x',
    probe: { url: `BASE${path}`, header: 'x-api-key', scheme: '', expect: id === 'obj' ? 'choices' : 'models', ...(method === 'POST' ? { body: { m: 1 } } : {}) } });
  const vendors = (base) => [mk('any', '/vendor-any', 'GET'), mk('shape', '/vendor-shape', 'GET'), mk('obj', '/vendor-obj', 'POST'), mk('redir', '/vendor-redirect', 'GET')]
    .map((v) => ({ ...v, probe: { ...v.probe, url: v.probe.url.replace('BASE', base) } }));
  const r = await fmCollect({ deployments: DEPLOYS, vendors, vaultList });
  assert.match(r.out, /any \(accepts a bad key\)/);
  assert.match(r.out, /shape \(accepts a bad key\)/);   // refusing a malformed key is not authentication (r2.1)
  assert.match(r.out, /obj \(bad answer\)/);
  assert.match(r.out, /redir \(no answer\)/);
  assert.equal(r.stolen.length, 0, 'a redirect carried a credential to another host');
  assert.doesNotMatch(r.calls, /testkey123|PW-SECRET-3/);   // a fake secret no random temp-dir suffix can contain (CI 2026-11-17: tc-checks-8tPW9e matched /PW/)
});

test('forge-models collect: a control that gets no answer is "no answer", never "accepts a bad key"; a GET control is retried once', async () => {
  const vaultList = [{ type: 1, name: 'assemblyai-api-key', login: { password: 'PW-SECRET-3', uris: [] } }];
  const mk = (id, path, post) => ({ id, label: id, provider: 'p', modality: ['llm'], policy: 'vendor-direct', vault: 'assemblyai-api-key', instrument: 'x',
    probe: { url: `BASE${path}`, header: 'x-api-key', scheme: '', expect: 'transcripts', allowEmpty: true, ...(post ? { body: { m: 1 } } : {}) } });
  const one = async (path, post) => fmCollect({ deployments: DEPLOYS, vaultList,
    vendors: (base) => [mk('v', path, post)].map((v) => ({ ...v, probe: { ...v.probe, url: v.probe.url.replace('BASE', base) } })) });
  const real = (h) => h['x-api-key'] === 'testkey123';
  const count = (r) => [r.vendorHeaders.filter((h) => !real(h)).length, r.vendorHeaders.filter(real).length];
  const dead = await one('/vendor-drop');
  assert.match(dead.out, /v \(no answer\)/);
  assert.doesNotMatch(dead.out, /accepts a bad key/);
  assert.deepEqual(count(dead), [2, 0], 'a dead GET control: two wrong-key tries (one retry, no more), the real key never sent');
  const flaky = await one('/vendor-drop-once');
  assert.doesNotMatch(flaky.out, /v \((no answer|accepts a bad key)\)/);
  assert.equal(flaky.direct.models.find((m) => m.name === 'v').reachable, true);
  assert.deepEqual(count(flaky), [2, 1], 'a recovered GET control: the retry, then one real probe');
  const deadPost = await one('/vendor-drop', true);
  assert.match(deadPost.out, /v \(no answer\)/);
  assert.deepEqual(count(deadPost), [1, 0], 'a POST control is never retried (r1.2)');
});

test('forge-models vendors: the shipped forge-direct.json is well formed (r1.1)', async () => {
  const { vendorSpec, scanPatterns } = await import(join(C, 'forge-models.mjs'));
  const cfg = JSON.parse(readFileSync(join(C, 'forge-direct.json'), 'utf8'));
  assert.equal(cfg.vendors[0].id, 'assemblyai', 'AssemblyAI first (JP 07:43)');
  assert.equal(new Set(cfg.vendors.map((v) => v.id)).size, cfg.vendors.length);
  const modal = new Set(['stt', 'tts', 'llm', 'embeddings', 'vision', 'image', 'video']);
  const accounted = new Set(Object.values(cfg.vendorScan.accountedNames).flat());
  for (const v of cfg.vendors) {
    assert.ok(/^[a-z0-9-]{1,40}$/.test(v.id) && v.label && v.provider && v.policy, v.id);
    assert.ok(Array.isArray(v.modality) && v.modality.length && v.modality.every((m) => modal.has(m)), `${v.id} modality`);
    if (v.probe === null) { assert.ok(v.why && v.vault, `${v.id}: an unprobed row says why`); continue; }
    const spec = vendorSpec(v.probe);
    assert.ok(spec, `${v.id}: probe spec`);
    assert.ok(spec.auth === 'entra' ? !v.vault : !!v.vault, `${v.id}: a key row names its vault item, an Entra row none`);
    if (v.vault) assert.ok(!accounted.has(v.vault), `${v.id}: listed and accounted at once`);
    if (v.probe.body) assert.ok(v.probe.body.max_tokens <= 2, `${v.id}: an inference probe stays tiny`);
  }
  assert.ok(scanPatterns(cfg.vendorScan.patterns) && scanPatterns(Object.keys(cfg.vendorScan.accountedPatterns)));
  assert.ok(cfg.vendorsWithoutKey.every((x) => typeof x.vendor === 'string' && typeof x.status === 'string'));
});

test('forge-models vendors: wrongKey keeps the shape and changes the value', async () => {
  const { wrongKey } = await import(join(C, 'forge-models.mjs'));
  for (const k of ['testkey123', 'nvapi-AbCdEfGh0123456789zZ', 'a1b2c3d4e5f6a7b8c9d0', 'eyJ0eXAi.payload.sig-_9Zz']) {
    const w = wrongKey(k);
    assert.notEqual(w, k); assert.equal(w.length, k.length);
    assert.equal(w.replace(/[0-9]/g, '0').replace(/[a-z]/g, 'a').replace(/[A-Z]/g, 'A'), k.replace(/[0-9]/g, '0').replace(/[a-z]/g, 'a').replace(/[A-Z]/g, 'A'));
  }
  assert.equal(wrongKey('--------'), '--------');   // nothing to shift: the probe then refuses to trust itself
});

test('forge-models vendors: an allowed pattern cannot be made slow (r2.2), and a quantifier fails as config', { timeout: 60_000 }, () => {
  const heavy = '(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)$';   // the worst the language allows: bounded, no loop
  const cfgOk = { ...FM_VCFG, vendorScan: { ...FM_VCFG.vendorScan, patterns: [...FM_VCFG.vendorScan.patterns, heavy] } };
  const names = Array.from({ length: 300 }, (_, i) => ({ name: 'a'.repeat(196) + String(i).padStart(3, '0') + '!', hosts: [] }));   // 200 characters, a near miss at the end
  const t0 = Date.now();
  const ok = fm(fmV({ vaultItems: [...FM_VAULT, ...names] }), {}, cfgOk);
  assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
  assert.match(ok.line, /^CHECK forge-models ok/);
  for (const bad of ['(a+)+$', 'x{2,}', '[', '\\d', 'a?a?a?a?a?a?a?a?a?$', '(?=a)']) {
    const cfg = { ...FM_VCFG, vendorScan: { ...FM_VCFG.vendorScan, patterns: [...FM_VCFG.vendorScan.patterns, bad] } };
    const r = fm(fmV({ vaultItems: [...FM_VAULT, { name: 'a'.repeat(5000) + '!', hosts: [] }] }), {}, cfg);
    assert.match(r.line, /^CHECK forge-models fail · .*config: a vendorScan pattern is not allowed/, bad);
  }
});

test('forge-models: a world-writable HOME refuses publication (r2.5)', () => {
  const d = fresh(); mkdirSync(join(d, 'forge'), { mode: 0o700 }); chmodSync(d, 0o777);
  writeFileSync(join(d, 'cfg.json'), JSON.stringify(FM_CFG)); writeFileSync(join(d, 'in.json'), JSON.stringify(fmIn()));
  const r = run('forge-models.sh', { CHECK_FM_HOME: d, CHECK_FM_CONFIG: join(d, 'cfg.json'), CHECK_FM_INPUTS: join(d, 'in.json'), CHECK_FM_OUT: join(d, 'forge', 'direct.json'), CHECK_FM_NOW_MS: String(FM_NOW) });
  chmodSync(d, 0o700);
  // group write by this user's own private group (Ubuntu's 775 ~/srv) is allowed; the test host's
  // group is private when /etc/group lists it for this user with no members
  chmodSync(d, 0o770);
  const r2 = run('forge-models.sh', { CHECK_FM_HOME: d, CHECK_FM_CONFIG: join(d, 'cfg.json'), CHECK_FM_INPUTS: join(d, 'in.json'), CHECK_FM_OUT: join(d, 'forge', 'direct.json'), CHECK_FM_NOW_MS: String(FM_NOW) });
  chmodSync(d, 0o700);
  // through a fake getent (r8.1): private → written; another account sharing the gid → refused
  const bin = join(d, 'bin'); mkdirSync(bin);
  const me = process.env.USER || 'u', gid = process.getgid();
  const fakeGetent = (others, dupGroup = false) => { writeFileSync(join(bin, 'getent'), `#!/bin/sh\ncase "$1" in group) echo "${me}:x:${gid}:"${dupGroup ? `; echo "shared:x:${gid}:intruder"` : ''};; passwd) echo "${me}:x:${process.getuid()}:${gid}::/h:/bin/sh"${others ? `; echo "intruder:x:4242:${gid}::/h:/bin/sh"` : ''};; esac\n`); chmodSync(join(bin, 'getent'), 0o755); };
  writeFileSync(join(d, 'nss-local'), 'passwd: files systemd\ngroup: files [SUCCESS=merge] systemd\n');
  writeFileSync(join(d, 'nss-sss'), 'passwd: files sss\ngroup: files sss\n');
  const env3 = { CHECK_FM_NSSWITCH: join(d, 'nss-local'), PATH: `${bin}:${process.env.PATH}`, CHECK_FM_HOME: d, CHECK_FM_CONFIG: join(d, 'cfg.json'), CHECK_FM_INPUTS: join(d, 'in.json'), CHECK_FM_OUT: join(d, 'forge', 'direct.json'), CHECK_FM_NOW_MS: String(FM_NOW) };
  fakeGetent(false); chmodSync(d, 0o770);
  const r3 = run('forge-models.sh', env3);
  fakeGetent(true);
  const r4 = run('forge-models.sh', env3);
  fakeGetent(false);
  const r5 = run('forge-models.sh', { ...env3, CHECK_FM_NSSWITCH: join(d, 'nss-sss') });   // r9.1: SSSD may hide accounts
  writeFileSync(join(bin, 'getent'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'getent'), 0o755);
  const r6 = run('forge-models.sh', env3);                                                 // r9.1: an empty listing proves nothing
  fakeGetent(false, true);
  const r7 = run('forge-models.sh', env3);                                                 // a second group line with the same gid
  chmodSync(d, 0o700);
  assert.match(r5.line, /direct\.json not written \(EPATH\)/);
  assert.match(r6.line, /direct\.json not written \(EPATH\)/);
  assert.match(r7.line, /direct\.json not written \(EPATH\)/);
  if (userInfo().username === me) assert.doesNotMatch(r3.line, /not written/);
  assert.match(r4.line, /^CHECK forge-models warn · .*direct\.json not written \(EPATH\)/);
  assert.match(r.line, /^CHECK forge-models warn · .*direct\.json not written \(EPATH\)/);   // never ok while the page goes stale (r3.3)
});

test('forge-models collect: one call counted twice cannot cover another that never reached the proxy (r2.1)', async () => {
  const r = await fmCollect({ deployments: DEPLOYS, claudeCounts: 'twice-then-none' });
  assert.match(r.out, /^fail\t.*claude-fable-5-2 \(not seen at the seat proxy\)/);
  assert.doesNotMatch(r.out, /claude-opus-5-5 \(not seen/);
});


test('forge-models collect: an empty or non-WAV audio answer, or a bad image answer, is not a reachable model (r3.2)', async () => {
  const ok = await fmCollect({ deployments: [...DEPLOYS, { id: 'gpt-audio-mini', model: 'gpt-audio-mini', status: 'succeeded' }] });
  assert.doesNotMatch(ok.out, /foundry:gpt-(audio-mini|image-1\.5) \(/);
  for (const audio of [JSON.stringify({ choices: [{ message: { audio: { data: '' } } }] }), JSON.stringify({ choices: [{ message: { audio: { data: Buffer.alloc(3000).toString('base64') } } }] }), 'not json']) {
    const r = await fmCollect({ deployments: [...DEPLOYS, { id: 'gpt-audio-mini', model: 'gpt-audio-mini', status: 'succeeded' }], audio });
    assert.match(r.out, /^fail\t.*foundry:gpt-audio-mini \(bad answer\)/);
  }
  const r = await fmCollect({ deployments: [...DEPLOYS, { id: 'gpt-audio-mini', model: 'gpt-audio-mini', status: 'succeeded' }], image: JSON.stringify({ data: [{ b64_json: '' }] }) });
  assert.match(r.out, /^fail\t.*foundry:gpt-image-1\.5 \(bad answer\)/);
});


// bounded twice (r5.3): fmCollect's child is killed after 60 s (its output is then not a verdict, so the
// match fails), and the runner itself stops this test after 150 s
test('forge-models collect: a Wyoming peer that closes early or sends half an answer does not hang the check (r4.2)', { timeout: 150_000 }, async () => {
  for (const mode of ['eof', 'truncated']) {
    const { createServer: tcp } = await import('node:net');
    const srv = tcp((c) => { if (mode === 'truncated') c.write('{"type": "info", "data_length": 500}\n{"wa'); c.end(); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const t0 = Date.now();
    const r = await fmCollect({ deployments: DEPLOYS, wyomingPort: srv.address().port });
    srv.close();
    assert.equal(typeof r.out, 'string', `${mode}: the collector was killed at its deadline`);
    assert.ok(Date.now() - t0 < 30_000, mode);
    assert.match(r.out, /^fail\t.*openwakeword \(no answer\)/, mode);
  }
});


test('forge-models collect: a Wyoming peer that trickles bytes forever is cut off by an absolute deadline (r6.1)', { timeout: 150_000 }, async () => {
  const { createServer: tcp } = await import('node:net');
  const conns = [];
  const srv = tcp((c) => { conns.push(c); const iv = setInterval(() => c.write('{'), 1000); c.on('close', () => clearInterval(iv)); c.on('error', () => {}); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  const r = await fmCollect({ deployments: DEPLOYS, wyomingPort: srv.address().port });
  for (const c of conns) c.destroy();
  srv.close();
  assert.equal(typeof r.out, 'string');
  assert.ok(Date.now() - t0 < 40_000, `took ${Date.now() - t0} ms`);
  assert.match(r.out, /^fail\t.*openwakeword \(no answer\)/);
});

test('forge-models collect: a 200 that is not an image, or a TTS 200 that is not the WAV asked for, is a bad answer (r6.2)', async () => {
  const img = await fmCollect({ deployments: DEPLOYS, image: JSON.stringify({ data: [{ b64_json: Buffer.alloc(3000).toString('base64') }] }) });
  assert.match(img.out, /^fail\t.*foundry:gpt-image-1\.5 \(bad answer\)/);
  const tts = await fmCollect({ deployments: DEPLOYS, tts: Buffer.from('<html>' + 'x'.repeat(2000) + '</html>') });
  assert.match(tts.out, /^fail\t.*en-US-Ava:DragonHDLatestNeural \(bad answer\)/);
});


test('forge-models collect: malformed Wyoming wake data is no answer, never a crash (r7.2)', { timeout: 150_000 }, async () => {
  const { createServer: tcp } = await import('node:net');
  for (const data of [{ wake: [{ models: {} }] }, { wake: [null] }, { wake: [{ models: [null] }] }, { wake: [{ models: [{ name: 5 }] }] }]) {
    const body = JSON.stringify(data);
    const srv = tcp((c) => { c.on('error', () => {}); c.write(JSON.stringify({ type: 'info', data_length: body.length }) + '\n' + body); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const r = await fmCollect({ deployments: DEPLOYS, wyomingPort: srv.address().port });
    srv.close();
    assert.match(r.out ?? '', /^fail\t.*openwakeword \(no answer\)/, JSON.stringify(data));
  }
});

// ---------- security-scan (row f3fb83d4: JP 2026-11-23 "scan teamclaude and litellm all the time")
// What is real in these tests, by name: "[live VM]" runs the real VM script (sh, against a git clone) and the
// real ls-tree comparison; "[live git]" runs real git fetch; "[stub X]" runs the real probe function with a stub
// binary X on PATH (its exit status and output are what the check must read); everything else in a test comes
// from recorded probe output (fixtures), parsed by the same code the live probes feed. No test reaches the
// network, the VM, ubox0, GitHub or the vault.
const PIN = (c) => c.repeat(64);
const SHA = (c) => c.repeat(40);
// [live VM] tests expect the proxy process: a stand-in whose command line carries a pattern unique to this test
// process (CI runs other suites' real `src/index.js server` at the same time, and pgrep sees the whole host: on
// 2026-11-24 the shared pattern matched one of those). The `; :` keeps sh from exec'ing sleep, which would drop
// that argument. Started before the files are made, killed after.
const PROC_PATTERN = `tc-scan-test-proxy-${process.pid}`;
const fakeProxy = spawn('sh', ['-c', 'sleep 600; :', PROC_PATTERN], { stdio: 'ignore' });
after(() => fakeProxy.kill());
spawnSync('sleep', ['1.1']);   // the stand-in's start second is before any file the tests write
const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...BASE_ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
function scanRepo() { // a fork with origin/master and upstream/master refs, and a VM clone of it
  const d = fresh();
  const tc = join(d, 'tc');
  mkdirSync(join(tc, 'src'), { recursive: true }); mkdirSync(join(tc, 'bin'));
  writeFileSync(join(tc, 'package.json'), '{"name":"t","devDependencies":{"eslint":"^9.0.0"}}\n');
  writeFileSync(join(tc, 'src', 'index.js'), 'console.log(1)\n');
  writeFileSync(join(tc, 'bin', 'tc'), '#!/bin/sh\n'); chmodSync(join(tc, 'bin', 'tc'), 0o755);
  writeFileSync(join(tc, '.gitignore'), 'scratch/\n');
  writeFileSync(join(tc, 'README.md'), 'r\n');
  git(d, 'init', '-q', tc); git(tc, 'add', '.'); git(tc, 'commit', '-qm', 'one');
  const sha = git(tc, 'rev-parse', 'HEAD');
  git(tc, 'update-ref', 'refs/remotes/origin/master', sha);
  git(tc, 'update-ref', 'refs/remotes/upstream/master', sha);
  const vm = join(d, 'vm');
  git(d, 'clone', '-q', tc, vm);
  // the VM's files predate the running proxy (the stand-in above), as a deployed checkout does
  spawnSync('find', [vm, '-path', join(vm, '.git'), '-prune', '-o', '-exec', 'touch', '-h', '-d', '@1000000000', '{}', '+']);
  return { d, tc, vm, sha };
}
function stubs(dir, scripts) { // name -> shell body; returns a PATH with the stubs first
  const b = join(dir, 'stubs'); mkdirSync(b, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) { writeFileSync(join(b, name), `#!/bin/sh\n${body}\n`); chmodSync(join(b, name), 0o755); }
  return `${b}:${process.env.PATH}`;
}
const AUDIT = (v = {}, rc = 1, vulns = {}) => `${JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 1, total: 1, ...v } }, vulnerabilities: vulns })}\n#RC ${rc}\n`;
const COMPOSE = `services:\n  db: # the gateway's database\n    image: postgres@sha256:${PIN('b')}\n  litellm:\n    image: ghcr.io/berriai/litellm-non_root@sha256:${PIN('a')} # v1.106.9\nnetworks:\n  internal: {internal: true}\n`;
const DOCKER = `/forge-litellm-1 litellm sha256:${PIN('9')} ghcr.io/berriai/litellm-non_root@sha256:${PIN('a')}\n/forge-db-1 db sha256:${PIN('8')} postgres@sha256:${PIN('b')}\n`;
function scanFixtures(over = {}) {
  const fx = fresh();
  const files = {
    'fetch.txt': 'teamclaude 0\nupstream 0\nforge-gateway 0\n',
    'gitleaks-teamclaude.json': '[]\n#RC 0\n',
    'gitleaks-forge-gateway.json': '[]\n#RC 0\n',
    'audit.json': AUDIT(),
    'compose.yaml': COMPOSE,
    'osv.json': '{}\n#RC 0\n',
    'upstream.txt': `${SHA('1')}\n${SHA('2')}\n`,
    'prs-teamclaude.txt': '5\tsrc/server.js\n',
    'prs-forge-gateway.txt': '',
    'upstream-prs.txt': '',
    'docker.txt': DOCKER,
    ...over,
  };
  for (const [k, v] of Object.entries(files)) if (v !== null) writeFileSync(join(fx, k), v);
  return fx;
}
function scan(fx, { repo = scanRepo(), state = fresh(), flowFails = false, env = {} } = {}) {
  const rows = join(state, 'rows.txt');
  const flow = join(state, 'flow.sh');
  writeFileSync(flow, flowFails ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\nprintf '%s\\n' "$1" >> '${rows}'\n`);
  chmodSync(flow, 0o755);
  const r = run('security-scan.sh', { CHECK_STATE_DIR: state, CHECK_SCAN_FIXTURES: fx, CHECK_SCAN_FLOW: flow, CHECK_SCAN_TC_REPO: repo.tc,
    CHECK_SCAN_FG_REPO: repo.tc, CHECK_SCAN_VM_RUN: 'sh -s --', CHECK_SCAN_VM_DIR: repo.vm, CHECK_SCAN_VM_PROC: PROC_PATTERN, ...env });
  return { ...r, repo, rows: existsSync(rows) ? readFileSync(rows, 'utf8').trim().split('\n').filter(Boolean) : [] };
}

test('security-scan [live VM]: a clean day is ok, every tracked file (dotfiles too) equals the merged tree, the baseline recorded at the end, no row', () => {
  const r = scan(scanFixtures());
  assert.equal(r.status, 0);
  assert.match(r.line, LINE);
  assert.match(r.line, /^CHECK security-scan ok · teamclaude gitleaks 0; forge-gateway gitleaks 0; npm audit 0 critical 0 high 0 moderate; litellm 1\.106\.9 OSV 0; upstream 2 commits not in the fork; VM [0-9a-f]{7}( \S+)? proxy running, files = merged tree \(5 files\); forge services \(db litellm\): each running its pin; upstream baseline recorded; rows filed 0, at \d\d:\d\d · /, r.line);
  assert.deepEqual(r.rows, []);
});

test('security-scan [live git]: a failed fetch warns, names the stale refs, and files a row', () => {
  const repo = scanRepo();
  git(repo.tc, 'remote', 'add', 'origin', join(repo.d, 'gone'));
  git(repo.tc, 'remote', 'add', 'upstream', join(repo.d, 'gone'));
  const r = scan(scanFixtures({ 'fetch.txt': null }), { repo });
  assert.match(r.line, /^CHECK security-scan warn · fetch failed: teamclaude upstream forge-gateway \(compared against the last fetched refs\); /, r.line);
  assert.match(r.rows[0], /^security-scan could not see: fetch failed: teamclaude upstream forge-gateway/);
  assert.match(r.line, /upstream baseline not recorded: the run was incomplete/, 'a blind run never writes the first baseline');
});

test('security-scan: a blind probe files one row while it stays blind, and a new one after it has seen again', () => {
  const repo = scanRepo(); const state = fresh();
  const blindFx = scanFixtures({ 'osv.json': 'oops\n#RC 0\n' });
  assert.equal(scan(blindFx, { repo, state }).rows.length, 1);
  assert.equal(scan(blindFx, { repo, state }).rows.length, 1, 'still blind: no second row');
  scan(scanFixtures(), { repo, state });
  const again = scan(blindFx, { repo, state });
  assert.equal(again.rows.length, 2, 'blind again after seeing: a new row');
  assert.match(again.rows[1], /^security-scan could not see: litellm 1\.106\.9 OSV could not be read/);
});

test('security-scan: a leak fails and becomes one row, never twice; values never reach the line', () => {
  const leak = JSON.stringify([{ RuleID: 'generic-api-key', File: 'src/x.js', StartLine: 3, Commit: SHA('d'), Fingerprint: `${SHA('d')}:src/x.js:generic-api-key:3`, Secret: 'REDACTED', Match: 'k = REDACTED' }]);
  const repo = scanRepo(); const state = fresh();
  const fx = scanFixtures({ 'gitleaks-teamclaude.json': `${leak}\n#RC 1\n` });
  const r = scan(fx, { repo, state });
  assert.match(r.line, /^CHECK security-scan fail · teamclaude gitleaks 1: generic-api-key src\/x\.js; /);
  assert.equal(r.rows.length, 1);
  assert.match(r.rows[0], /gitleaks found generic-api-key at src\/x\.js:3 \(ddddddd\) in teamclaude main history/);
  assert.equal(scan(fx, { repo, state }).rows.length, 1, 'the second run files nothing new');
  assert.doesNotMatch(r.line, /REDACTED|k = /);
});

test('security-scan [stub gitleaks]: gitleaks that cannot scan fails with a row: an error exit, malformed output, status and report disagreeing', () => {
  let r = scan(scanFixtures({ 'gitleaks-teamclaude.json': null }), { env: { PATH: stubs(fresh(), { gitleaks: 'exit 2' }) } });
  assert.match(r.line, /^CHECK security-scan fail · teamclaude gitleaks could not scan \(exit 2\); /, r.line);
  assert.match(r.rows[0], /could not see: teamclaude gitleaks could not scan/);
  r = scan(scanFixtures({ 'gitleaks-teamclaude.json': 'oops\n#RC 0\n' }));
  assert.match(r.line, /^CHECK security-scan fail · teamclaude gitleaks could not scan \(exit 0\)/);
  r = scan(scanFixtures({ 'gitleaks-forge-gateway.json': '[]\n#RC 1\n' }));
  assert.match(r.line, /^CHECK security-scan fail · .*forge-gateway gitleaks could not scan \(exit 1\)/);
});

test('security-scan [stub npm]: npm audit high fails, moderate warns, counts without names still file; an error exit, a disagreement or malformed JSON fails with a row', () => {
  let r = scan(scanFixtures({ 'audit.json': AUDIT({ high: 1, total: 1, low: 0 }, 1, { eslint: { severity: 'high' } }) }));
  assert.match(r.line, /^CHECK security-scan fail · .*npm audit 0 critical 1 high 0 moderate \(eslint\(high\)\)/);
  assert.match(r.rows.join('\n'), /npm audit flags eslint\(high\)/);
  r = scan(scanFixtures({ 'audit.json': AUDIT({ moderate: 1, total: 1, low: 0 }) }));
  assert.match(r.line, /^CHECK security-scan warn · .*0 high 1 moderate/);
  assert.match(r.rows[0], /npm audit counts 0 critical 0 high 1 moderate .* packages unnamed/);
  r = scan(scanFixtures({ 'audit.json': '{"metadata":{}}\n#RC 0\n' }));
  assert.match(r.line, /^CHECK security-scan fail · .*npm audit could not be read \(exit 0\)/, 'no counts is not zero counts');
  assert.match(r.rows[0], /could not see: npm audit could not be read/);
  assert.match(scan(scanFixtures({ 'audit.json': AUDIT({ low: 0, total: 0 }, 1) })).line, /npm audit could not be read \(exit 1\)/, 'exit 1 with no advisory disagrees');
  r = scan(scanFixtures({ 'audit.json': null }), { env: { PATH: stubs(fresh(), { npm: '[ "$1" = install ] && exit 0; echo "npm ERR! network"; exit 7' }) } });
  assert.match(r.line, /^CHECK security-scan fail · .*npm audit could not be read \(exit 7\)/, r.line);
  r = scan(scanFixtures({ 'audit.json': null }), { env: { PATH: stubs(fresh(), { npm: 'exit 1' }) } });
  assert.match(r.line, /npm audit could not be read \(exit install-1\)/, r.line);
});

test('security-scan [stub curl]: any OSV advisory fails with its severity; {} (OSV\'s no-advisory answer) is zero; null, malformed or unreachable fails with a row', () => {
  let r = scan(scanFixtures({ 'osv.json': `${JSON.stringify({ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N' }] }, { id: 'PYSEC-1', database_specific: { severity: 'LOW' } }] })}\n#RC 0\n` }));
  assert.match(r.line, /^CHECK security-scan fail · .*litellm 1\.106\.9 OSV: GHSA-aaaa-bbbb-cccc=CVSS:3\.1\/AV:N PYSEC-1=LOW; /, 'a LOW advisory still fails: nothing is under-classified');
  assert.equal(r.rows.length, 2);
  assert.match(scan(scanFixtures({ 'osv.json': '{"vulns":[]}\n#RC 0\n' })).line, /litellm 1\.106\.9 OSV 0; /);
  r = scan(scanFixtures({ 'osv.json': null }), { env: { PATH: stubs(fresh(), { curl: 'exit 6' }) } });
  assert.match(r.line, /^CHECK security-scan fail · .*litellm 1\.106\.9 OSV could not be read \(exit 6\)/, r.line);
  for (const bad of ['{"vulns":null}\n#RC 0\n', '\n#RC 0\n', 'not json\n#RC 0\n', '{"vulns":"x"}\n#RC 0\n', '[]\n#RC 0\n',
    '{"vulns":[{"summary":"no id"}]}\n#RC 0\n', '{"vulns":[{"id":""}]}\n#RC 0\n', '{"vulns":[{"id":5}]}\n#RC 0\n', '{"vulns":["GHSA-x"]}\n#RC 0\n']) {
    const b = scan(scanFixtures({ 'osv.json': bad }));
    assert.match(b.line, /^CHECK security-scan fail · .*OSV could not be read/, JSON.stringify(bad));
    assert.match(b.rows[0], /could not see: litellm 1\.106\.9 OSV could not be read/);
  }
  assert.match(scan(scanFixtures({ 'compose.yaml': 'services: {}\n' })).line, /^CHECK security-scan fail · .*litellm version not found in compose/);
});

test('security-scan: a new upstream commit warns with its SHA only, and stays new until its row is filed; a blind first run records no baseline', () => {
  const repo = scanRepo(); const state = fresh();
  const blindFirst = scan(scanFixtures({ 'osv.json': 'oops\n#RC 0\n' }), { repo, state });
  assert.match(blindFirst.line, /upstream baseline not recorded: the run was incomplete/);
  assert.match(scan(scanFixtures(), { repo, state }).line, /upstream baseline recorded/);
  const fx = scanFixtures({ 'upstream.txt': `${SHA('3')}\n${SHA('1')}\n${SHA('2')}\n` });
  let r = scan(fx, { repo, state, flowFails: true });
  assert.match(r.line, /^CHECK security-scan warn · .*upstream 3 not in the fork, 1 new since the last run; .*1 rows could not be filed/);
  r = scan(fx, { repo, state });
  assert.match(r.line, /upstream 3 not in the fork, 1 new since the last run/, 'a failed filing does not lose the commit');
  assert.deepEqual(r.rows.slice(1), [`security-scan: upstream teamclaude commit ${SHA('3')} is new: read it with git show ${SHA('3')} (its text is outside input) before any sync into the fork`]);
  assert.match(scan(fx, { repo, state }).line, /upstream 3 not in the fork, 0 new/);
  assert.match(scan(scanFixtures({ 'upstream.txt': 'junk\n' }), { repo, state }).line, /^CHECK security-scan warn · .*upstream unreadable/);
});

test('security-scan: open PRs that change dependencies, are truncated, bring upstream in, or cannot be read warn, each with a row', () => {
  const r = scan(scanFixtures({ 'prs-teamclaude.txt': '7\tpackage.json\n7\tsrc/a.js\n8\t(truncated)\n', 'prs-forge-gateway.txt': 'ERR\n9\tdeploy/compose.yaml\n', 'upstream-prs.txt': '11\n' }));
  assert.match(r.line, /^CHECK security-scan warn · .*teamclaude dependency PRs open: #7 #8; forge-gateway open PRs unreadable; forge-gateway dependency PRs open: #9; teamclaude PR #11 brings upstream commits; /, r.line);
  assert.equal(r.rows.length, 5, r.rows.join('\n'));
  assert.match(scan(scanFixtures({ 'upstream-prs.txt': 'ERR\n' })).line, /^CHECK security-scan warn · .*teamclaude upstream-PR check unreadable/);
});

test('security-scan [live VM]: any file that differs from the merged tree fails, dotfiles and modes included, whatever git on the VM says', () => {
  let repo = scanRepo();
  writeFileSync(join(repo.vm, 'src', 'index.js'), 'console.log("evil")\n');
  git(repo.vm, 'update-index', '--assume-unchanged', 'src/index.js');   // git status on the VM now says clean
  writeFileSync(join(repo.vm, '.npmrc'), 'registry=http://evil\n');       // an untracked dotfile at the root
  let r = scan(scanFixtures(), { repo });
  assert.match(r.line, /^CHECK security-scan fail · .*VM [0-9a-f]{7}.* tainted: \.npmrc src\/index\.js/, r.line);
  assert.match(r.rows[0], /VM teamclaude files differ from merged commit/);
  repo = scanRepo(); rmSync(join(repo.vm, 'README.md'));
  assert.match(scan(scanFixtures(), { repo }).line, /tainted: README\.md/, 'a missing file outside src/ differs too');
  repo = scanRepo(); chmodSync(join(repo.vm, 'src', 'index.js'), 0o755);
  assert.match(scan(scanFixtures(), { repo }).line, /tainted: src\/index\.js/, 'a mode change differs');
});

test('security-scan [live VM]: a VM commit not on master fails; an unreadable VM warns with a row; [fixture] files newer than the running node warn', () => {
  const repo = scanRepo();
  writeFileSync(join(repo.vm, 'src', 'index.js'), 'console.log(2)\n'); git(repo.vm, 'commit', '-qam', 'unmerged');
  let r = scan(scanFixtures(), { repo });
  assert.match(r.line, /^CHECK security-scan fail · .*VM [0-9a-f]{7}.* NOT on master/, r.line);
  assert.match(r.rows[0], /names commit [0-9a-f]{40}, which is not on origin\/master/);
  r = scan(scanFixtures(), { env: { CHECK_SCAN_VM_RUN: 'false' } });
  assert.match(r.line, /^CHECK security-scan warn · .*VM checkout unreadable/);
  assert.match(r.rows[0], /could not see: VM checkout unreadable/);
  const ok = scanRepo();
  const files = git(ok.tc, 'ls-tree', '-r', 'HEAD').split('\n').map((l) => { const [m, , b] = l.split('\t')[0].split(' '); return `FILE ${m} ${b} ${l.split('\t')[1]}`; }).join('\n');
  r = scan(scanFixtures({ 'vm.txt': `HEAD ${ok.sha}\nPROCS 1\nPROC 42\nSTART 1\n${files}\nNEWER src/index.js\nNODE v24.22.1\n` }), { repo: ok });
  assert.match(r.line, /^CHECK security-scan warn · .*VM [0-9a-f]{7} v24\.22\.1 files newer than the running node: src\/index\.js/, r.line);
});

test('security-scan [live VM, stub pgrep]: the expected proxy process not running is a fail with a row, never a clean inventory', () => {
  const PATH = stubs(fresh(), { pgrep: 'exit 1' });
  let r = scan(scanFixtures(), { env: { CHECK_SCAN_VM_RUN: `env PATH=${PATH} sh -s --` } });
  assert.match(r.line, /^CHECK security-scan fail · .*VM [0-9a-f]{7}( \S+)? proxy \(node src\/index\.js server\) NOT running/, r.line);
  assert.doesNotMatch(r.line, /files = merged tree/);
  assert.match(r.rows[0], /the expected proxy process \(node src\/index\.js server\) is not running/);
  const ok = scanRepo();
  const files = git(ok.tc, 'ls-tree', '-r', 'HEAD').split('\n').map((l) => { const [m, , b] = l.split('\t')[0].split(' '); return `FILE ${m} ${b} ${l.split('\t')[1]}`; }).join('\n');
  r = scan(scanFixtures({ 'vm.txt': `HEAD ${ok.sha}\nPROCS 1\nPROC 42\n${files}\nNODE v24.22.1\n` }), { repo: ok });
  assert.match(r.line, /^CHECK security-scan fail · .*NOT running/, 'a process with no readable start time is not a clean run');
});

test('security-scan [live VM]: the default-shaped pattern counts the node process, not a supervisor carrying its command line (VM 2026-11-24)', () => {
  const d = fresh(); const tag = `tcscan${process.pid}sv`;
  mkdirSync(join(d, tag, 'src'), { recursive: true });
  const script = join(d, tag, 'src', 'index.js');
  writeFileSync(script, 'setTimeout(() => {}, 600000);\n');
  const node = spawn(process.execPath, [script, 'server'], { stdio: 'ignore' });
  const sup = spawn('sh', ['-c', 'sleep 600; :', `supervise-daemon teamclaude --start /opt/node/bin/node -- ${script} server`], { stdio: 'ignore' });
  try {
    spawnSync('sleep', ['0.5']);
    const r = scan(scanFixtures(), { env: { CHECK_SCAN_VM_PROC: `^[^ ]*node [^ ]*${tag}/src/index[.]js server` } });
    assert.match(r.line, /VM [0-9a-f]{7}( \S+)? proxy running, files = merged tree/, r.line);
  } finally { node.kill(); sup.kill(); }
});

test('security-scan [live VM]: two processes matching the proxy fail (the expected set is exactly one: an orphan holds old code)', () => {
  const orphan = spawn('sh', ['-c', 'sleep 600; :', PROC_PATTERN], { stdio: 'ignore' });
  try {
    spawnSync('sleep', ['0.3']);
    const r = scan(scanFixtures());
    assert.match(r.line, /^CHECK security-scan fail · .*VM [0-9a-f]{7}( \S+)? 2 proxy processes \(expected exactly 1\)/, r.line);
    assert.match(r.rows[0], /2 processes match the proxy \(expected exactly 1\)/);
  } finally { orphan.kill(); }
});

test('security-scan: every compose service needs exactly one pin and a running container on it; the covered set is named', () => {
  let r = scan(scanFixtures({ 'docker.txt': `/forge-litellm-1 litellm sha256:${PIN('9')} ghcr.io/berriai/litellm-non_root@sha256:${PIN('a')}\n` }));
  assert.match(r.line, /^CHECK security-scan fail · .*forge services \(db litellm\) NOT all on their pins: db=not-running/, r.line);
  r = scan(scanFixtures({ 'compose.yaml': `${COMPOSE.replace('networks:', '  web:\n    image: nginx:latest\nnetworks:')}`, 'docker.txt': `${DOCKER}/forge-web-1 web sha256:${PIN('6')} nginx@sha256:${PIN('6')}\n` }));
  assert.match(r.line, /forge services \(db litellm web\) NOT all on their pins: web=unpinned .*forge-web-1\(web\)=6666/, r.line);
});

test('security-scan [stub docker]: each container must run its OWN service\'s pinned digest; a commented service line parses; another service\'s pin is not enough', () => {
  let r = scan(scanFixtures({ 'docker.txt': `/forge-litellm-1 litellm sha256:${PIN('9')} postgres@sha256:${PIN('b')}\n/forge-db-1 db sha256:${PIN('8')} postgres@sha256:${PIN('b')}\n` }));
  assert.match(r.line, /^CHECK security-scan fail · .*forge services \(db litellm\) NOT all on their pins: forge-litellm-1\(litellm\)=9999/, r.line);
  assert.match(r.rows[0], /not each running their own pinned digest/);
  assert.match(scan(scanFixtures({ 'docker.txt': `${DOCKER}/forge-x-1 x sha256:${PIN('7')} postgres@sha256:${PIN('b')}\n` })).line, /NOT all on their pins: forge-x-1\(x\)/, 'a container of a service compose does not have fails');
  // two containers; each answers for itself (the container id is the inspect call's last argument)
  const docker = `last=$(eval echo \\\${$#})
case "$1 $2" in
  "ps -q") echo c1 c2 ;;
  "inspect -f") case "$3:$last" in
      *Name*:c1) echo /forge-db-1 ;; *Name*:c2) echo /forge-litellm-1 ;;
      *compose.service*:c1) echo db ;; *compose.service*:c2) echo litellm ;;
      *:c1) echo "sha256:${PIN('b')}" ;; *:c2) echo "sha256:${PIN('9')}" ;; esac ;;
  "image inspect") case "$last" in *${PIN('9')}) echo "ghcr.io/berriai/litellm-non_root@sha256:${PIN('a')}" ;; *) echo "" ;; esac ;;
esac`;
  r = scan(scanFixtures({ 'docker.txt': null }), { env: { PATH: stubs(fresh(), { docker }), CHECK_SCAN_DOCKER_RUN: 'sh -s --' } });
  assert.match(r.line, /forge services \(db litellm\): each running its pin/, `db by image id = manifest digest, litellm by RepoDigests: ${r.line}`);
  r = scan(scanFixtures({ 'docker.txt': '' }));
  assert.match(r.line, /^CHECK security-scan warn · .*forge containers or compose services unreadable/);
  assert.match(r.rows[0], /could not see: forge containers or compose services unreadable/);
});
