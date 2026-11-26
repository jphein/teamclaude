// scripts/serialhub-gate.sh (row 8aa26057): the gate runs on a lane host in a dedicated clone, detached at the
// commit asked for. Here the "host" is this machine: TC_GATE_SSH is a stub that runs the remote script with
// bash, TC_GATE_REPO a local bare repo, TC_GATE_DIR a temp clone dir.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync, readFileSync } from 'node:fs';
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

/** A bare "fork" with master at two commits and a branch, and a stub ssh that runs the remote script here. */
function setup() {
  const d = fresh();
  const work = join(d, 'work'); const bare = join(d, 'fork.git');
  git(d, 'init', '-q', '-b', 'master', work);
  writeFileSync(join(work, 'package.json'), '{"name":"t","private":true}\n');
  writeFileSync(join(work, 'marker'), 'one\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'one');
  const one = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'marker'), 'two\n');
  git(work, 'commit', '-qam', 'two');
  const two = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-qb', 'feat/x');
  writeFileSync(join(work, 'marker'), 'branch\n');
  git(work, 'commit', '-qam', 'branch');
  git(d, 'clone', '-q', '--bare', work, bare);
  const ssh = join(d, 'ssh');
  const hosts = join(d, 'hosts');
  writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${hosts}'\nshift\nexec bash -c "$1"\n`);
  chmodSync(ssh, 0o755);
  return { d, bare, one, two, ssh, hosts, clone: join(d, 'gate-clone') };
}
function gate(s, args, { env = {}, input } = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', input, timeout: 60000,
    env: { ...ENV, TC_GATE_SSH: s.ssh, TC_GATE_HOST: 'gatehost', TC_GATE_REPO: s.bare, TC_GATE_DIR: s.clone, ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test('serialhub-gate: runs the command in a clean clone detached at the commit asked for, on the host named, and exits with its status', () => {
  const s = setup();
  const r = gate(s, [s.one, '--', 'cat marker; git rev-parse HEAD; exit 3']);
  assert.equal(r.status, 3, r.err);
  assert.match(r.out, new RegExp(`^gate on \\S+ at ${s.one} · node v\\d+`, 'm'));
  assert.match(r.out, new RegExp(`^one\\n${s.one}$`, 'm'));
  assert.deepEqual(readFileSync(s.hosts, 'utf8').trim().split('\n'), ['gatehost']);
});

test('serialhub-gate: a branch name is the fork\'s branch; a later run moves the same clone and removes what the last one left', () => {
  const s = setup();
  assert.equal(gate(s, ['feat/x', '--', 'touch leftover; mkdir -p scratch && touch scratch/x']).status, 0);
  const r = gate(s, ['master', '--', 'cat marker; ls leftover scratch 2>&1; true']);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, new RegExp(`at ${s.two} `));
  assert.match(r.out, /^two$/m);
  assert.match(r.out, /leftover: No such file/);
  assert.ok(existsSync(join(s.clone, '.git')), 'one clone, reused');
});

test('serialhub-gate: stdin reaches the command, so a local perturbation script runs in the clone', () => {
  const s = setup();
  const r = gate(s, [s.two, '--', 'sh -s'], { input: 'cat marker\necho from-stdin\n' });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^two\nfrom-stdin$/m);
});

test('serialhub-gate: the command keeps its own quoting and never meets the remote shell unquoted', () => {
  const s = setup();
  const r = gate(s, [s.two, '--', `printf '%s|' "a b" 'c;d' "$(echo e)"; echo`]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^a b\|c;d\|e\|$/m);
});

test('serialhub-gate: a ref that is not a plain ref is refused before anything runs (22); an unknown one fails on the host (22)', () => {
  const s = setup();
  for (const bad of ['-x', 'a;touch pwned', '$(id)', 'a b', 'a..b', '']) {
    const r = gate(s, [bad, '--', 'true']);
    assert.equal(r.status, 22, `${JSON.stringify(bad)}: ${r.err}`);
    assert.ok(!existsSync(s.hosts), `${JSON.stringify(bad)} reached the host`);
  }
  const r = gate(s, ['no-such-branch', '--', 'echo ran']);
  assert.equal(r.status, 22, r.err);
  assert.match(r.err, /no-such-branch is not a commit or branch/);
  assert.doesNotMatch(r.out, /ran/);
  assert.equal(gate(s, []).status, 22, 'no ref: usage');
  assert.equal(gate(s, [s.two, 'echo', 'x']).status, 22, 'a command without -- : usage');
});

test('serialhub-gate: the default command is the full local gate, scripts/gate.sh against origin/master', () => {
  const s = setup();
  const r = gate(s, [s.two], { env: { PATH: `${s.d}:${process.env.PATH}` } });
  // the fixture repo has no scripts/gate.sh: the default command is what fails, by name
  assert.notEqual(r.status, 0);
  assert.match(r.err, /scripts\/gate\.sh/);
});
