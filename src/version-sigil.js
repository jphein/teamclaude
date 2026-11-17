// GET /api/version: the realm-sigil version document (JP 2026-11-17 05:07, via
// realmwatch #493: every web project carries realm-sigil). CHECK sigil-coverage
// reads `version` ("<Name> · <hash>") and `hash` from it.
//
// Served before the key gate, so it carries only what identifies the build:
// no host, pid, uptime, OS or runtime (the full realm-sigil shape has them, and
// this endpoint answers anyone who can reach the proxy).
//
// The hash is resolved ONCE, when the server is created: the document names
// the code that is running, and a `git pull` without a restart must not change
// it. Without a checkout (an npm or Nix install) there is no hash to name, and
// the document says so (`hash: null`) rather than inventing one.

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { generateName } = require('./vendor/realm-sigil/index.cjs');

const NAME = 'teamclaude';
const DESCRIPTION = 'TeamClaude proxy';
const REALM = 'fantasy';
const REPO = 'https://github.com/jphein/teamclaude';
const HEX = /^[0-9a-f]{7,40}$/;

const packageRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The version document for the code at `root`.
 *
 * @param {Object} [opts]
 * @param {string} [opts.root]
 * @param {(file: string, args: string[], options: { cwd: string, encoding: 'utf8', timeout: number }) => Promise<{ stdout: string }>} [opts.exec]
 * @returns {Promise<Record<string, string | null>>}
 */
export async function resolveSigil({ root = packageRoot(), exec = promisify(execFile) } = {}) {
  let hash = null;
  if (existsSync(join(root, '.git'))) {
    try {
      const out = String((await exec('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 2000 })).stdout).trim();
      if (HEX.test(out)) hash = out;
    } catch { /* a broken checkout or no git binary: no hash */ }
  }
  const base = { name: NAME, description: DESCRIPTION, realm: REALM, repo: REPO };
  return hash
    ? { ...base, version: generateName(hash, REALM), hash, commit_url: `${REPO}/commit/${hash}` }
    : { ...base, version: `${NAME} · unknown`, hash: null, commit_url: null };
}
