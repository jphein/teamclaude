// scripts/serialhub-gate.sh (row 8aa26057): the gate runs on a lane host in a dedicated clone, detached at the
// commit asked for. Here the "host" is this machine: TC_GATE_SSH is a stub that runs the remote command line
// with sh (as a login shell would), TC_GATE_REPO a local bare repo, TC_GATE_DIR a temp clone dir.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'serialhub-gate.sh');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'tc-shgate-')); dirs.push(d); return d; };

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy']) delete ENV[k];
const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const LOCK = '{"name":"t","lockfileVersion":3,"requires":true,"packages":{"":{"name":"t"}}}\n';

/** A bare "fork" with master at two commits and a branch, and a stub ssh that runs the remote command here.
 *  STUB_BEFORE, when set, runs between the caller's resolve and the host's fetch (a push landing meanwhile). */
function setup({ lock = true } = {}) {
  const d = fresh();
  const work = join(d, 'work'); const bare = join(d, 'fork.git');
  git(d, 'init', '-q', '-b', 'master', work);
  writeFileSync(join(work, 'package.json'), '{"name":"t","private":true}\n');
  if (lock) writeFileSync(join(work, 'package-lock.json'), LOCK);
  writeFileSync(join(work, 'marker'), 'one\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'one');
  const one = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'marker'), 'two\n');
  git(work, 'commit', '-qam', 'two');
  const two = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-qb', 'feat/x');
  writeFileSync(join(work, 'marker'), 'branch\n');
  git(work, 'commit', '-qam', 'branch');
  const branch = git(work, 'rev-parse', 'HEAD');
  git(d, 'clone', '-q', '--bare', work, bare);
  const ssh = join(d, 'ssh');
  const hosts = join(d, 'hosts');
  writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${hosts}'\nshift\n[ -z "\${STUB_BEFORE:-}" ] || sh -c "$STUB_BEFORE"\nexec sh -c "$1"\n`);
  chmodSync(ssh, 0o755);
  return { d, work, bare, one, two, branch, ssh, hosts, clone: join(d, 'gate-clone') };
}
function gate(s, args, { env = {}, input } = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', input, timeout: 60000,
    env: { ...ENV, TC_GATE_SSH: s.ssh, TC_GATE_HOST: 'gatehost', TC_GATE_REPO: s.bare, TC_GATE_DIR: s.clone, ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test('serialhub-gate: runs the command in a clean clone detached at the commit asked for, on the host named, and exits with its status', () => {
  const s = setup();
  const r = gate(s, [s.one, '--', 'sh', '-c', 'cat marker; git rev-parse HEAD; exit 3']);
  assert.equal(r.status, 3, r.err);
  assert.match(r.out, new RegExp(`^gate on \\S+ at ${s.one} · node v\\d+`, 'm'));
  assert.match(r.out, new RegExp(`^one\\n${s.one}$`, 'm'));
  assert.deepEqual(readFileSync(s.hosts, 'utf8').trim().split('\n'), ['gatehost']);
});

test('serialhub-gate: a branch name is the fork\'s branch; a later run moves the same clone and removes what the last one left', () => {
  const s = setup();
  assert.equal(gate(s, ['feat/x', '--', 'sh', '-c', 'touch leftover; mkdir -p scratch && touch scratch/x']).status, 0);
  const r = gate(s, ['master', '--', 'sh', '-c', 'cat marker; ls leftover scratch 2>&1; true']);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, new RegExp(`at ${s.two} `));
  assert.match(r.out, /^two$/m);
  assert.match(r.out, /\bleftover'?: No such file/);
  assert.match(r.out, /\bscratch'?: No such file/);
  assert.ok(existsSync(join(s.clone, '.git')), 'one clone, reused');
});

test('serialhub-gate: a branch is resolved to its commit before the host is reached, and that commit is what runs', () => {
  const s = setup();
  // a push to feat/x lands between the caller's resolve and the host's fetch
  const moved = `git -C '${s.work}' commit -q --allow-empty -m moved && git -C '${s.work}' push -q '${s.bare}' HEAD:feat/x`;
  const r = gate(s, ['feat/x', '--', 'git', 'rev-parse', 'HEAD'], { env: { STUB_BEFORE: moved } });
  assert.equal(r.status, 0, r.err);
  assert.notEqual(git(s.bare, 'rev-parse', 'feat/x'), s.branch, 'the branch did move');
  assert.match(r.err, new RegExp(`^serialhub-gate: feat/x is ${s.branch}$`, 'm'));
  assert.match(r.out, new RegExp(`at ${s.branch} `));
  assert.match(r.out, new RegExp(`^${s.branch}$`, 'm'));
});

test('serialhub-gate: stdin reaches the command, so a local perturbation script runs in the clone', () => {
  const s = setup();
  const r = gate(s, [s.two, '--', 'sh', '-s'], { input: 'cat marker\necho from-stdin\n' });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^two\nfrom-stdin$/m);
});

test('serialhub-gate: the command is an argv that reaches the host word for word, never re-read by a shell', () => {
  const s = setup();
  const args = ['a b', 'c;d', '$(echo e)', '', "it's", '*', 'x\ny'];
  const r = gate(s, [s.two, '--', 'printf', '<%s>', ...args]);
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.endsWith(args.map((a) => `<${a}>`).join('')), JSON.stringify(r.out));
});

test('serialhub-gate: a second gate on the same clone while one runs is refused (75), and the first is untouched', () => {
  const s = setup();
  const nested = `bash '${SCRIPT}' "$1" -- true; echo "nested=$?"; cat marker`;
  const r = gate(s, [s.two, '--', 'sh', '-c', nested, 'sh', s.one]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^nested=75\ntwo$/m);
  assert.match(r.err, /another gate holds .*gate-clone/);
});

test('serialhub-gate: installs only with npm ci from the commit\'s package-lock.json; none is a refusal (65)', () => {
  const s = setup({ lock: false });
  const r = gate(s, [s.two, '--', 'echo', 'ran']);
  assert.equal(r.status, 65, r.err);
  assert.match(r.err, /no package-lock\.json/);
  assert.doesNotMatch(r.out, /ran/);
  // With a lockfile, the one npm command the host runs is `npm ci`, never `npm install` (the lead's ruling on PR
  // 106, round 2). A stub npm records what it is asked. TC_GATE_NODE names a major mise does not hold, so the host
  // keeps this PATH (stub first) and this node.
  const ok = setup();
  const bin = join(ok.d, 'bin'); mkdirSync(bin);
  const seen = join(ok.d, 'npm-seen');
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${seen}'\n`); chmodSync(join(bin, 'npm'), 0o755);
  const g = gate(ok, [ok.two, '--', 'echo', 'ran'], { env: { PATH: `${bin}:${process.env.PATH}`, TC_GATE_NODE: '99' } });
  assert.equal(g.status, 0, g.err);
  assert.match(g.out, /^ran$/m);
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), ['ci --no-audit --no-fund --ignore-scripts']);
});

test('serialhub-gate: npm keeps its cache and logs out of the host home, and removes them after the run', () => {
  const s = setup();
  const home = fresh();
  const r = gate(s, [s.two, '--', 'sh', '-c', 'echo "cache=$npm_config_cache"; echo "logs=$npm_config_logs_dir"'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.err);
  assert.ok(!existsSync(join(home, '.npm')), `npm wrote under the host home: ${readdirSync(home).join(' ')}`);
  const cache = r.out.match(/^cache=(\S+)$/m)?.[1];
  const logs = r.out.match(/^logs=(\S+)$/m)?.[1];
  assert.ok(cache && !cache.startsWith(home), `cache: ${cache}`);
  assert.ok(logs && dirname(logs) === dirname(cache), `logs: ${logs}, cache: ${cache}`);
  // the per-run directory both live in, beside the clone, and each of them, are gone after the run
  const perRun = dirname(cache);
  assert.match(perRun, /gate-clone\.npm\.[A-Za-z0-9]{6}$/);
  for (const p of [cache, logs, perRun]) assert.ok(!existsSync(p), `${p} is left after the run`);
  assert.deepEqual(readdirSync(dirname(perRun)).filter((n) => n.includes('.npm.')), [], 'no per-run npm dir is left beside the clone');
});

test('serialhub-gate: a ref that is not a plain ref, or unknown, is refused before the host is reached (22)', () => {
  const s = setup();
  for (const bad of ['-x', 'a;touch pwned', '$(id)', 'a b', 'a..b', '', 'no-such-branch']) {
    const r = gate(s, [bad, '--', 'true']);
    assert.equal(r.status, 22, `${JSON.stringify(bad)}: ${r.err}`);
    assert.ok(!existsSync(s.hosts), `${JSON.stringify(bad)} reached the host`);
  }
  assert.match(gate(s, ['no-such-branch', '--', 'true']).err, /no-such-branch is not a branch of .* or a commit/);
  assert.equal(gate(s, []).status, 22, 'no ref: usage');
  assert.equal(gate(s, [s.two, 'echo', 'x']).status, 22, 'a command without -- : usage');
  assert.equal(gate(s, [s.two, '--']).status, 22, '-- with no command: usage');
});

test('serialhub-gate: the default command is the full local gate, scripts/gate.sh against origin/master', () => {
  const s = setup();
  const r = gate(s, [s.two]);
  // the fixture repo has no scripts/gate.sh: the default command is what fails, by name
  assert.notEqual(r.status, 0);
  assert.match(r.err, /scripts\/gate\.sh/);
});
