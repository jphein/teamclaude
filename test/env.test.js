import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEnvExports } from '../src/config.js';

const config = { proxy: { port: 3456, apiKey: 'tc-secret' } };

test('env defaults to localhost and the configured port', () => {
  const lines = buildEnvExports(config);
  assert.deepEqual(lines, [
    'export ANTHROPIC_BASE_URL=http://localhost:3456',
    'export ANTHROPIC_API_KEY=tc-secret',
  ]);
});

test('--host points a remote client at this machine instead of localhost', () => {
  const lines = buildEnvExports(config, { host: '10.0.6.129' });
  assert.equal(lines[0], 'export ANTHROPIC_BASE_URL=http://10.0.6.129:3456');
  // The API key line is what gets a remote client past the non-localhost
  // auth gate — it must always be present.
  assert.equal(lines[1], 'export ANTHROPIC_API_KEY=tc-secret');
});

test('--port override is honored; falls back to config otherwise', () => {
  assert.equal(
    buildEnvExports(config, { host: 'serialhub.lan', port: '9999' })[0],
    'export ANTHROPIC_BASE_URL=http://serialhub.lan:9999',
  );
  assert.equal(
    buildEnvExports(config, { host: 'serialhub.lan' })[0],
    'export ANTHROPIC_BASE_URL=http://serialhub.lan:3456',
  );
});
