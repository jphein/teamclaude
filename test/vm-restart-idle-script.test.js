import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The VM restart script must never put the operator key where `ps` shows it:
// no argv, no environment, no shell variable. Node reads it from the config
// file inside its own process, and only there.
const script = readFileSync(new URL('../scripts/vm-restart-idle.sh', import.meta.url), 'utf8');
const code = script.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');

test('the restart script reads the key inside node, never through argv or env', () => {
  assert.doesNotMatch(code, /process\.argv/, 'no key passed as an argument');
  assert.doesNotMatch(code, /process\.env\.(?!HOME\b)/, 'no key passed through the environment');
  assert.doesNotMatch(code, /\$\(\s*[^)]*apiKey/, 'no key captured into a shell variable');
  const keyLines = code.split('\n').filter(l => /apiKey/.test(l));
  assert.equal(keyLines.length, 1);
  assert.match(keyLines[0], /readFileSync\(process\.env\.HOME \+ '\/\.config\/teamclaude\.json'/);
});

test('the node snippet is fed on stdin, not with -e', () => {
  assert.match(code, /\/opt\/node\/bin\/node - <<'JS'/);
  assert.doesNotMatch(code, /node -e/);
});
