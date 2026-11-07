import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// The VM restart script must never put the operator key where `ps` shows it:
// no argv, no environment, no shell variable. Node reads it from the config
// file inside its own process, and only there.
const script = readFileSync(new URL('../scripts/vm-restart-idle.sh', import.meta.url), 'utf8');
const code = script.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');

test('the restart script reads the key inside node, never through argv or env', () => {
  assert.doesNotMatch(code, /process\.argv/, 'no key passed as an argument');
  assert.doesNotMatch(code, /process\.env\.(?!HOME\b|TC_STATUS_PORT\b)/, 'no key passed through the environment');
  assert.doesNotMatch(code, /\$\(\s*[^)]*apiKey/, 'no key captured into a shell variable');
  const keyLines = code.split('\n').filter(l => /apiKey/.test(l));
  assert.equal(keyLines.length, 1);
  assert.match(keyLines[0], /readFileSync\(process\.env\.HOME \+ '\/\.config\/teamclaude\.json'/);
});

test('the node snippet is fed on stdin, not with -e', () => {
  assert.match(code, /\/opt\/node\/bin\/node - <<'JS'/);
  assert.doesNotMatch(code, /node -e/);
});

// Behaviour of the idle check itself: the node snippet run against a fake
// status server. Only a well-formed all-zero reading may exit 0.
const snippet = script.slice(script.indexOf("<<'JS'\n") + 7, script.indexOf('\nJS\n'));

async function idleExit(status, body) {
  const home = mkdtempSync(join(tmpdir(), 'tc-idle-'));
  mkdirSync(join(home, '.config'));
  writeFileSync(join(home, '.config', 'teamclaude.json'), JSON.stringify({ proxy: { apiKey: 'tc-fake' } }));
  let seenKey = null;
  const server = createServer((req, res) => { seenKey = req.headers['x-api-key']; res.writeHead(status); res.end(body); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = /** @type {any} */ (server.address()).port;
  try {
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath, ['-'], { env: { HOME: home, TC_STATUS_PORT: String(port), PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('exit', resolve);
      child.stdin.end(snippet);
    });
    return { code, seenKey };
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test('idle check: exit 0 only for a well-formed all-zero status', async () => {
  const ok = await idleExit(200, JSON.stringify({ accounts: [{ inFlight: 0 }, { inFlight: 0 }] }));
  assert.equal(ok.code, 0);
  assert.equal(ok.seenKey, 'tc-fake', 'the key came from the config file');
  assert.equal((await idleExit(200, JSON.stringify({ accounts: [{ inFlight: 0 }, { inFlight: 2 }] }))).code, 1, 'busy');
});

test('idle check: anything malformed or failed is not idle', async () => {
  for (const [status, body, why] of [
    [200, JSON.stringify({ accounts: [{}] }), 'missing counter'],
    [200, JSON.stringify({ accounts: [{ inFlight: null }] }), 'null counter'],
    [200, JSON.stringify({ accounts: [{ inFlight: -1 }, { inFlight: 1 }] }), 'negative cancels positive'],
    [200, JSON.stringify({ accounts: [] }), 'no accounts'],
    [200, '{not json', 'bad json'],
    [500, JSON.stringify({ accounts: [{ inFlight: 0 }] }), 'error status with an idle-looking body'],
  ]) {
    assert.equal((await idleExit(/** @type {number} */ (status), /** @type {string} */ (body))).code, 2, why);
  }
});

test('idle check: a redirect is refused and the key never follows it', async () => {
  let elsewhere = 0;
  const other = createServer((req, res) => { elsewhere++; res.writeHead(200); res.end(JSON.stringify({ accounts: [{ inFlight: 0 }] })); });
  await new Promise(r => other.listen(0, '127.0.0.1', r));
  const to = `http://127.0.0.1:${/** @type {any} */ (other.address()).port}/teamclaude/status`;
  try {
    const home = mkdtempSync(join(tmpdir(), 'tc-idle-'));
    mkdirSync(join(home, '.config'));
    writeFileSync(join(home, '.config', 'teamclaude.json'), JSON.stringify({ proxy: { apiKey: 'tc-fake' } }));
    const redirector = createServer((req, res) => { res.writeHead(302, { location: to }); res.end(); });
    await new Promise(r => redirector.listen(0, '127.0.0.1', r));
    const port = /** @type {any} */ (redirector.address()).port;
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath, ['-'], { env: { HOME: home, TC_STATUS_PORT: String(port), PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('exit', resolve);
      child.stdin.end(snippet);
    });
    redirector.close();
    rmSync(home, { recursive: true, force: true });
    assert.equal(code, 2);
    assert.equal(elsewhere, 0, 'the redirect target was never asked');
  } finally {
    other.close();
  }
});

test('the wait is a wall-clock deadline, re-checked before the restart', () => {
  assert.match(code, /deadline=\$\(\( \$\(date \+%s\) \+ WAIT \)\)/);
  assert.match(code, /idle && sleep 1 && idle && \[ "\$\(date \+%s\)" -lt "\$deadline" \]/);
});
