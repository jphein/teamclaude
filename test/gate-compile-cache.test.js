import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// tsc and eslint enable Node's compile cache, which lands in os.tmpdir() unless
// NODE_COMPILE_CACHE says otherwise; /tmp is RAM on the hosts that run the gate.
const gate = readFileSync(new URL('../scripts/gate.sh', import.meta.url), 'utf8');
const line = gate.split('\n').find(l => l.startsWith('export NODE_COMPILE_CACHE='));

function resolve(env) {
  const r = spawnSync('bash', ['-c', `${line}\nprintf %s "$NODE_COMPILE_CACHE"`], { env, encoding: 'utf8' });
  return r.stdout;
}

test('the gate points the compile cache at the user cache dir, not /tmp', () => {
  assert.ok(line, 'gate.sh exports NODE_COMPILE_CACHE');
  assert.equal(resolve({ HOME: '/home/u', PATH: process.env.PATH ?? '' }), '/home/u/.cache/node-compile-cache');
  assert.equal(resolve({ HOME: '/home/u', XDG_CACHE_HOME: '/x', PATH: process.env.PATH ?? '' }), '/x/node-compile-cache');
});

test("a caller's own NODE_COMPILE_CACHE wins", () => {
  assert.equal(resolve({ HOME: '/home/u', NODE_COMPILE_CACHE: '/mine', PATH: process.env.PATH ?? '' }), '/mine');
});
