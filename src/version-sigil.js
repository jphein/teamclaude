// GET /api/version: the realm-sigil version document (JP 2026-11-17 05:07, via
// realmwatch #493: every web project carries realm-sigil). CHECK sigil-coverage
// reads `version` ("<Name> · <hash>") and `hash` from it.
//
// Security contract: served before the key gate, to anyone who can reach the
// proxy, so it discloses on purpose exactly two things: that this is TeamClaude,
// and which commit of it. That lets a caller fingerprint the version (and names
// a local commit that may not be pushed); it carries no account, credential,
// host, pid, OS, runtime or uptime (the full realm-sigil shape has those, and
// they are left out).
//
// What `hash` means: the package checkout's HEAD as seen when the server was
// created, and `dirty` says whether tracked files differed from it then. It is
// resolved once, so a later `git pull` without a restart does not change what
// the document says; it is not a build stamp, and files changed between the
// process loading and this read are not detected. Without a checkout (an npm or
// Nix install) the hash is null, never invented.

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
// The fork, not package.json's upstream (KarpelesLab): this fork is what is deployed, and the
// commits it runs (its PR merges) exist only here, so an upstream commit link would 404.
const REPO = 'https://github.com/jphein/teamclaude';
const HEX = /^[0-9a-f]{7,40}$/;

const packageRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * git's environment without anything that picks a repository other than the
 * one at `cwd` (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, …).
 * @param {NodeJS.ProcessEnv} env
 */
export function gitEnv(env = process.env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^GIT_/.test(k) && v !== undefined) out[k] = v;
  return out;
}

/**
 * The version document for the checkout at `root`.
 *
 * @param {Object} [opts]
 * @param {string} [opts.root]
 * @param {(file: string, args: string[], options: { cwd: string, encoding: 'utf8', timeout: number, env: Record<string, string> }) => Promise<{ stdout: string }>} [opts.exec]
 * @returns {Promise<Record<string, string | boolean | null>>}
 */
export async function resolveSigil({ root = packageRoot(), exec = promisify(execFile) } = {}) {
  let hash = null, dirty = null;
  if (existsSync(join(root, '.git'))) {
    const opts = { cwd: root, encoding: /** @type {'utf8'} */ ('utf8'), timeout: 2000, env: gitEnv() };
    try {
      const out = String((await exec('git', ['rev-parse', '--short=7', 'HEAD'], opts)).stdout).trim();
      if (HEX.test(out)) hash = out;
    } catch { /* a broken checkout or no git binary: no hash */ }
    if (hash) {
      try { dirty = String((await exec('git', ['status', '--porcelain', '--untracked-files=no'], opts)).stdout).trim() !== ''; }
      catch { dirty = true; }   // unknown is not clean
    }
  }
  const base = { name: NAME, description: DESCRIPTION, realm: REALM, repo: REPO };
  return hash
    ? { ...base, version: generateName(hash, REALM), hash, dirty, commit_url: `${REPO}/commit/${hash}` }
    : { ...base, version: `${NAME} · unknown`, hash: null, dirty: null, commit_url: null };
}
