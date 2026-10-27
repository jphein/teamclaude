// `npm test`: the suite, run with TMPDIR (and TMP/TEMP) pointing at a
// directory made for this run, removed again when it ends.
//
// Tests make their scratch directories with os.tmpdir(), and many never remove
// them: 5,180 were left in familiar's 512 MB /tmp on 2026-10-27, where they
// helped fill it and broke every other tool on the host that needed /tmp.
// Cleaning each test up one by one would leave the next new test to leak the
// same way; one directory per run cannot.
//
// Extra arguments go to `node --test` (e.g. `npm test -- test/sso.test.js`).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'teamclaude-tests-'));
const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
const run = spawnSync(process.execPath, ['--test', '--test-timeout=120000', ...process.argv.slice(2)], { stdio: 'inherit', env });
rmSync(root, { recursive: true, force: true });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
