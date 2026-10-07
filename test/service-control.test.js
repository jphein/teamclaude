import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, appendFile, rename, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { SessionTitles } from '../src/session-titles.js';
import {
  resolveLogSource, resolveRestartMethod, startRestartCommand, tailFile, splitLines, EXIT_FOR_RESTART, MAX_READ_BYTES,
} from '../src/service-control.js';

// The dashboard's log viewer and Restart button on a host without systemd
// (2026-10-07: teamclaude moved to an Alpine/OpenRC VM, where journalctl and
// `systemctl --user` do not exist). Defaults are the systemd ones, unchanged.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
};

// ── Settings ──────────────────────────────────────────────────

test('defaults are the systemd ones, byte for byte', () => {
  assert.deepEqual(resolveLogSource({}), { kind: 'journald' });
  assert.deepEqual(resolveLogSource({ service: { logs: 'journald' } }), { kind: 'journald' });
  assert.deepEqual(resolveRestartMethod({}), { kind: 'command', argv: ['systemctl', '--user', 'restart', 'teamclaude.service'] });
  assert.deepEqual(resolveRestartMethod({ service: { restart: 'systemd' } }), resolveRestartMethod(undefined));
});

test('a file, a command, exit, and off are each honoured; anything else is off with a reason', () => {
  assert.deepEqual(resolveLogSource({ service: { logs: { file: ' /var/log/teamclaude.log ' } } }), { kind: 'file', path: '/var/log/teamclaude.log' });
  assert.equal(resolveLogSource({ service: { logs: false } }).kind, 'off');
  for (const bad of ['syslog', { file: '' }, { file: 3 }, 7, true]) {
    const r = resolveLogSource({ service: { logs: bad } });
    assert.equal(r.kind, 'off', JSON.stringify(bad));
    assert.match(r.reason, /service\.logs/);
  }
  assert.deepEqual(resolveRestartMethod({ service: { restart: { command: ['rc-service', 'teamclaude', 'restart'] } } }),
    { kind: 'command', argv: ['rc-service', 'teamclaude', 'restart'] });
  assert.deepEqual(resolveRestartMethod({ service: { restart: 'exit' } }), { kind: 'exit' });
  assert.equal(resolveRestartMethod({ service: { restart: false } }).kind, 'off');
  // A shell string is refused, not split: nothing here is re-parsed by a shell.
  for (const bad of ['rc-service teamclaude restart', { command: [] }, { command: ['ok', ''] }, { command: [1] }, { command: 'x' }]) {
    const r = resolveRestartMethod({ service: { restart: bad } });
    assert.equal(r.kind, 'off', JSON.stringify(bad));
    assert.match(r.reason, /service\.restart/);
  }
});

// ── Restart command ───────────────────────────────────────────

function fakeSpawn(outcome) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (outcome === 'throw') throw Object.assign(new Error('bad'), { code: 'EINVAL' });
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    setImmediate(() => {
      if (outcome === 'spawn') child.emit('spawn');
      else child.emit('error', Object.assign(new Error(outcome), { code: outcome }));
    });
    calls.at(-1).child = child;
    return child;
  };
  return { fn, calls };
}

test('the restart command is started detached, and only a started one counts', async () => {
  const ok = fakeSpawn('spawn');
  assert.deepEqual(await startRestartCommand(['rc-service', 'teamclaude', 'restart'], { spawnFn: ok.fn }), { ok: true });
  assert.equal(ok.calls[0].cmd, 'rc-service');
  assert.deepEqual(ok.calls[0].args, ['teamclaude', 'restart']);
  assert.equal(ok.calls[0].opts.detached, true);
  assert.equal(ok.calls[0].child.unrefed, true);

  const missing = await startRestartCommand(['systemctl', '--user'], { spawnFn: fakeSpawn('ENOENT').fn });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 501);
  assert.match(missing.error, /"systemctl" is not installed here; set service\.restart/);
  assert.equal((await startRestartCommand(['x'], { spawnFn: fakeSpawn('EACCES').fn })).status, 500);
  assert.equal((await startRestartCommand(['x'], { spawnFn: fakeSpawn('throw').fn })).status, 500);
});

test('a restart binary that does not exist is reported as unavailable (real spawn)', async () => {
  const r = await startRestartCommand(['teamclaude-test-no-such-binary-7f3a']);
  assert.equal(r.ok, false);
  assert.equal(r.status, 501);
});

// ── File tail ─────────────────────────────────────────────────

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-tail-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('splitLines keeps the unterminated remainder and drops blank lines', () => {
  assert.deepEqual(splitLines('a\nb\r\n\nc'), { lines: ['a', 'b'], rest: 'c' });
  assert.deepEqual(splitLines(''), { lines: [], rest: '' });
});

test('tailFile: last N lines, then appends, a partial line only once complete', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'tc.log');
    await writeFile(path, Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const got = [];
    const stop = tailFile(path, { lines: 100, pollMs: 20, onLine: l => got.push(l) });
    try {
      await until(() => got.length === 100);
      assert.equal(got[0], 'line 50');
      assert.equal(got[99], 'line 149');
      await appendFile(path, 'new one\nhalf');
      await until(() => got.length === 101);
      assert.equal(got[100], 'new one');
      await new Promise(r => setTimeout(r, 80));
      assert.equal(got.length, 101, 'the unterminated line waits');
      await appendFile(path, ' done\n');
      await until(() => got.length === 102);
      assert.equal(got[101], 'half done');
    } finally { stop(); }
  });
});

test('tailFile follows truncation and rename rotation, and a file that appears late', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'tc.log');
    const got = [];
    const errors = [];
    const stop = tailFile(path, { pollMs: 20, onLine: l => got.push(l), onError: e => errors.push(e.code) });
    try {
      await until(() => errors.length === 1);
      await new Promise(r => setTimeout(r, 80));
      assert.deepEqual(errors, ['ENOENT'], 'reported once, not every poll');
      await writeFile(path, 'first\n');
      await until(() => got.includes('first'));
      await truncate(path, 0);
      await new Promise(r => setTimeout(r, 60));
      await appendFile(path, 'after truncate\n');
      await until(() => got.includes('after truncate'));
      await rename(path, path + '.1');
      await writeFile(path, 'after rotate\n');
      await until(() => got.includes('after rotate'));
      stop();
      await appendFile(path, 'after stop\n');
      await new Promise(r => setTimeout(r, 80));
      assert.ok(!got.includes('after stop'));
    } finally { stop(); }
  });
});

// ── Through the server ────────────────────────────────────────

function makeServer(service, hooks = {}) {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  return createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:9', ...(service ? { service } : {}) }, hooks);
}

test('GET /teamclaude/logs streams a configured log file as SSE', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'tc.log');
    await writeFile(path, 'booted\n');
    const server = makeServer({ logs: { file: path } });
    const port = await listen(server);
    const ctl = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/logs`, { signal: ctl.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /event-stream/);
      const reader = res.body.getReader();
      let text = '';
      const readUntil = async (s) => { while (!text.includes(s)) text += new TextDecoder().decode((await reader.read()).value); };
      await readUntil('data: "booted"');
      await appendFile(path, 'served a request\n');
      await readUntil('data: "served a request"');
    } finally { ctl.abort(); server.close(); }
  });
});

test('logs and restart that are off, or impossible here, answer 501 with the setting to change', async () => {
  const off = makeServer({ logs: false, restart: false });
  const port = await listen(off);
  try {
    const logs = await fetch(`http://127.0.0.1:${port}/teamclaude/logs`);
    assert.equal(logs.status, 501);
    assert.match((await logs.json()).error, /service\.logs: false/);
    const restart = await fetch(`http://127.0.0.1:${port}/teamclaude/restart`, { method: 'POST' });
    assert.equal(restart.status, 501);
    assert.deepEqual(Object.keys(await restart.json()).sort(), ['error', 'restarting']);
  } finally { off.close(); }

  const missing = makeServer({ restart: { command: ['teamclaude-test-no-such-binary-7f3a'] } });
  const port2 = await listen(missing);
  try {
    const r = await fetch(`http://127.0.0.1:${port2}/teamclaude/restart`, { method: 'POST' });
    assert.equal(r.status, 501);
    const body = await r.json();
    assert.equal(body.restarting, false);
    assert.match(body.error, /set service\.restart/);
  } finally { missing.close(); }
});

test('POST /teamclaude/restart runs the configured command, or the systemd default', async () => {
  for (const [service, argv] of [
    [null, ['systemctl', '--user', 'restart', 'teamclaude.service']],
    [{ restart: { command: ['rc-service', 'teamclaude', 'restart'] } }, ['rc-service', 'teamclaude', 'restart']],
  ]) {
    const spawned = fakeSpawn('spawn');
    const server = makeServer(service, { spawnFn: spawned.fn });
    const port = await listen(server);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/teamclaude/restart`, { method: 'POST' });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { restarting: true });
      assert.deepEqual([spawned.calls[0].cmd, ...spawned.calls[0].args], argv);
    } finally { server.close(); }
  }
});

test('restart: "exit" answers first, then exits non-zero for the supervisor', async () => {
  let exited = null;
  const server = makeServer({ restart: 'exit' }, { exitProcess: (code) => { exited = code; } });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/teamclaude/restart`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { restarting: true });
    await until(() => exited !== null);
    assert.equal(exited, EXIT_FOR_RESTART);
    assert.notEqual(EXIT_FOR_RESTART, 0);
  } finally { server.close(); }
});

// ── Session titles on a host with no ~/.claude ────────────────

test('session titles with no projects directory resolve to nothing, silently', async () => {
  const said = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => said.push(a.join(' '));
  try {
    const titles = new SessionTitles({ enabled: true, projectsDir: join(tmpdir(), 'tc-no-such-dir-9c1e', 'projects') });
    assert.equal(await titles.resolve('3f2afe4b-df91-402b-8792-e19b2a007cf6'), null);
    assert.equal(titles.get('3f2afe4b-df91-402b-8792-e19b2a007cf6'), null);
    await titles.idle();
  } finally { Object.assign(console, orig); }
  assert.deepEqual(said, []);
});

// ── Resource bounds (background security review, 2026-10-07) ─

test('tailFile reads at most MAX_READ_BYTES per poll: a burst is skipped to its tail with a marker', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'tc.log');
    await writeFile(path, 'start\n');
    const got = [];
    const stop = tailFile(path, { pollMs: 20, onLine: l => got.push(l) });
    try {
      await until(() => got.includes('start'));
      const burst = 4 * MAX_READ_BYTES;
      const line = 'x'.repeat(99) + '\n';
      await appendFile(path, line.repeat(Math.ceil(burst / line.length)) + 'last line\n');
      await until(() => got.includes('last line'));
      assert.ok(got.some(l => /bytes of log skipped/.test(l)), 'the skip is said, not silent');
      const emittedBytes = got.reduce((n, l) => n + l.length + 1, 0);
      assert.ok(emittedBytes < MAX_READ_BYTES, `emitted ${emittedBytes} bytes for a ${burst}-byte burst`);
    } finally { stop(); }
  });
});

test('tailFile drops an unterminated line that outgrows its bound instead of buffering it forever', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'tc.log');
    await writeFile(path, 'a\n');
    const got = [];
    const stop = tailFile(path, { pollMs: 20, onLine: l => got.push(l) });
    try {
      await until(() => got.includes('a'));
      await appendFile(path, 'y'.repeat(100 * 1024)); // no newline, under MAX_READ_BYTES
      await new Promise(r => setTimeout(r, 80));
      await appendFile(path, 'tail\nnext\n');
      await until(() => got.includes('next'));
      assert.ok(!got.some(l => l.length > 64 * 1024), 'the oversized partial line was not carried');
    } finally { stop(); }
  });
});

test('one restart at a time: a second request while one is under way is 409 and spawns nothing', async () => {
  const spawned = fakeSpawn('spawn');
  const server = makeServer({ restart: { command: ['rc-service', 'teamclaude', 'restart'] } }, { spawnFn: spawned.fn });
  const port = await listen(server);
  try {
    const [a, b] = await Promise.all([1, 2].map(() => fetch(`http://127.0.0.1:${port}/teamclaude/restart`, { method: 'POST' })));
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/teamclaude/restart`, { method: 'POST' })).status, 409);
    assert.equal(spawned.calls.length, 1);
  } finally { server.close(); }
  // A restart that failed to start does not block the next try.
  const missing = makeServer({ restart: { command: ['teamclaude-test-no-such-binary-7f3a'] } });
  const port2 = await listen(missing);
  try {
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`http://127.0.0.1:${port2}/teamclaude/restart`, { method: 'POST' })).status, 501);
  } finally { missing.close(); }
});

test('a missing /ui page costs one read and one log line, not one per (unauthenticated) request', async () => {
  const said = [];
  const orig = console.error;
  console.error = (...a) => said.push(a.join(' '));
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const server = createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:9' }, { uiPagePath: join(tmpdir(), 'tc-no-such-ui-3b7d.html') });
  const port = await listen(server);
  try {
    const statuses = await Promise.all(Array.from({ length: 20 }, () => fetch(`http://127.0.0.1:${port}/ui`).then(r => r.status)));
    for (let i = 0; i < 5; i++) statuses.push((await fetch(`http://127.0.0.1:${port}/ui`)).status);
    assert.ok(statuses.every(s => s === 500));
  } finally { server.close(); console.error = orig; }
  assert.equal(said.filter(s => s.includes('/ui page unavailable')).length, 1, JSON.stringify(said));
});
