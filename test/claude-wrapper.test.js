// scripts/claude-wrapper.sh is the `claude` on familiar's and wakizashi's PATH.
// When the local forwarder (127.0.0.1:3456) does not answer it must refuse to
// start rather than run on the host's own login, a seat outside the pool
// (2026-11-14). These tests run the real script against a fake claude binary.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'claude-wrapper.sh');
const dir = mkdtempSync(join(tmpdir(), 'tc-wrapper-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// The fake claude prints its args and the proxy env it was handed.
const fake = join(dir, 'fake-claude');
writeFileSync(fake, '#!/bin/sh\necho "ARGS=$*"\necho "HTTPS_PROXY=${HTTPS_PROXY:-unset}"\necho "CA=${NODE_EXTRA_CA_CERTS:-unset}"\necho "BASE=${ANTHROPIC_BASE_URL:-unset}"\n');
chmodSync(fake, 0o755);

const listen = () => new Promise((resolve) => {
  const srv = createServer((s) => s.destroy());
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});
// A port nothing listens on: bind one, then close it.
const closedPort = async () => {
  const srv = await listen();
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
};

function run(port, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH, HOME: dir,
    TEAMCLAUDE_PROXY_PORT: String(port), TEAMCLAUDE_REAL_CLAUDE: fake,
    ANTHROPIC_BASE_URL: 'http://stale.example', ...extraEnv,
  };
  return spawnSync('sh', [WRAPPER, '-p', 'hi there'], { env, encoding: 'utf8', timeout: 10_000 });
}

test('proxy up: claude runs through it with the CA, ANTHROPIC_BASE_URL cleared, args intact', async () => {
  const srv = await listen();
  try {
    const { port } = srv.address();
    const r = run(port);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ARGS=-p hi there$/m);
    assert.match(r.stdout, new RegExp(`^HTTPS_PROXY=http://127\\.0\\.0\\.1:${port}$`, 'm'));
    assert.match(r.stdout, new RegExp(`^CA=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.config/teamclaude-ca\\.pem$`, 'm'));
    assert.match(r.stdout, /^BASE=unset$/m);
    assert.equal(r.stderr, '');
  } finally { await new Promise((res) => srv.close(res)); }
});

test('proxy down: refuses to start (exit 69) with one line naming the opt-in, never runs claude', async () => {
  const port = await closedPort();
  const r = run(port);
  assert.equal(r.status, 69);
  assert.equal(r.stdout, '', 'the fake claude must not have run');
  assert.equal(r.stderr, `[claude] teamclaude proxy :${port} down; set TEAMCLAUDE_ALLOW_DIRECT=1 to run on the seat\n`);
});

test('proxy down + TEAMCLAUDE_ALLOW_DIRECT=1: runs on the own login and says so', async () => {
  const port = await closedPort();
  const r = run(port, { TEAMCLAUDE_ALLOW_DIRECT: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^HTTPS_PROXY=unset$/m);
  assert.match(r.stderr, /teamclaude proxy :\d+ down; TEAMCLAUDE_ALLOW_DIRECT=1, so running on .+'s own login, outside the pool/);
});

test('only the literal value 1 opts in: TEAMCLAUDE_ALLOW_DIRECT=0 or yes still refuses', async () => {
  const port = await closedPort();
  for (const v of ['0', 'yes', '']) {
    const r = run(port, { TEAMCLAUDE_ALLOW_DIRECT: v });
    assert.equal(r.status, 69, `value ${JSON.stringify(v)}`);
    assert.equal(r.stdout, '');
  }
});

test('TEAMCLAUDE_BYPASS skips an up proxy and says so on stderr', async () => {
  const srv = await listen();
  try {
    const r = run(srv.address().port, { TEAMCLAUDE_BYPASS: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^HTTPS_PROXY=unset$/m);
    assert.match(r.stderr, /TEAMCLAUDE_BYPASS set: running on .+'s own login, outside the teamclaude pool/);
  } finally { await new Promise((res) => srv.close(res)); }
});
