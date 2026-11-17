import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

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
  assert.match(code, /\/opt\/node\/bin\/node - 2>\/dev\/null <<'JS'/);
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

test('idle check: a malformed config exits 2 and prints nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tc-idle-'));
  mkdirSync(join(home, '.config'));
  writeFileSync(join(home, '.config', 'teamclaude.json'), '{"proxy": {"apiKey": tc-unquoted-secret}}');
  try {
    const { code, err } = await new Promise(resolve => {
      const child = spawn(process.execPath, ['-'], { env: { HOME: home, TC_STATUS_PORT: '9', PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('exit', c => resolve({ code: c, err: out }));
      child.stdin.end(snippet);
    });
    assert.equal(code, 2);
    assert.equal(err, '', 'nothing printed, so nothing of the key');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- after the restart: prove it (2026-11-15 outage: the old node outlived the restart, every
// new child died on "port in use" for 7.5 h, and this script had already printed "restarted").
// The body runs under BusyBox sh, as on the VM, against a fake OpenRC child record, a fake /proc, a fake
// :3456 listener table and a real local quota server.
const remote = script.slice(script.indexOf("<<'REMOTE'\n") + 11, script.indexOf('\nREMOTE\n'));
const BUSYBOX = ['/usr/bin/busybox', '/bin/busybox'].find(p => { try { readFileSync(p); return true; } catch { return false; } });

/**
 * @param {{ restart: string, quota?: number, delayMs?: number, idle?: string, before?: string }} o
 *   restart: shell run as the "restart"; OLDGONE, NEWCHILD(pid,start[,state]) and LISTENER(pid) expand to fixture edits.
 */
async function restartRun(o) {
  const d = mkdtempSync(join(tmpdir(), 'tc-restart-'));
  const stat = (/** @type {string} */ pid, /** @type {string} */ start, state = 'S') =>
    `mkdir -p ${d}/proc/${pid}; echo "${pid} (node) ${state} ${Array.from({ length: 18 }, (_, i) => i + 4).join(' ')} ${start} 0" > ${d}/proc/${pid}/stat`;
  const expand = (/** @type {string} */ sh) => sh
    .replace(/NEWCHILD\((\d+),(\d+)(?:,([A-Z]))?\)/g, (_, p, st, state) => `${stat(p, st, state ?? 'S')}; echo ${p} > ${d}/child_pid`)
    .replace(/LISTENER\(([\d ]*)\)/g, (_, p) => `printf '%s\\n' ${p} > ${d}/listener`)
    .replace(/OLDGONE/g, `rm -rf ${d}/proc/4242`)
    .replaceAll('$D', d);
  // the quota server; with o.onRequest it first runs that fixture edit (e.g. a respawn while answering)
  const server = createServer((req, res) => {
    // the fixture edit is finished BEFORE the answer is sent (an unawaited edit raced the reply under
    // a loaded parallel suite: CI 2026-11-16, the respawn landed after the script had re-read the record)
    const edited = o.onRequest ? new Promise(r => spawn('sh', ['-c', expand(o.onRequest)]).on('exit', r)) : Promise.resolve();
    edited.then(() => setTimeout(() => { res.writeHead(o.quota ?? 200); res.end(o.body ?? '{}'); }, o.delayMs ?? 0));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = /** @type {any} */ (server.address()).port;
  try {
    const setup = spawn('sh', ['-c', expand(o.before ?? 'NEWCHILD(4242,100); LISTENER(4242)')]);
    await new Promise(r => setup.on('exit', r));
    return await new Promise(resolve => {
      const child = spawn(BUSYBOX ?? 'sh', BUSYBOX ? ['sh', '-s'] : ['-s'], {
        env: {
          PATH: process.env.PATH ?? '', HOME: d, WAIT: o.idle === 'false' ? '2' : '20', TC_IDLE_CMD: o.idle ?? 'true',
          TC_RESTART_CMD: expand(o.restart), TC_CHILD_FILE: `${d}/${o.childFile ?? 'child_pid'}`, TC_PROC: `${d}/proc`,
          TC_LISTENER_CMD: o.listenerCmd ? expand(o.listenerCmd) : `cat ${d}/listener`, TC_QUOTA_URL: `http://127.0.0.1:${port}/teamclaude/quota`,
          TC_VERIFY_WAIT: '3', TC_STEP: '1', ...(o.phase ? { PHASE: o.phase } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', c => { out += c; });
      child.stderr.on('data', c => { err += c; });
      child.on('exit', code => resolve({ code, out, err, dir: d }));
      child.stdin.end(remote);
    });
  } finally {
    server.close();
    server.closeAllConnections?.();
    // wait for the chmod itself, not a fixed 50 ms: a slow chmod left a 000 directory for rmSync
    await new Promise(r => spawn('chmod', ['-R', 'u+rwx', d]).on('exit', r));
    rmSync(d, { recursive: true, force: true });
  }
}

test('the remote body runs under BusyBox sh in these tests (the VM shell)', () => {
  assert.ok(BUSYBOX, 'busybox must be installed for the restart-proof tests');
});

test('restart verified: old child gone, new child recorded, owns :3456 and serves → exit 0, says which', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200); LISTENER(5151)' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /old child 4242:100 gone, new child 5151:200 alone on :3456 and serving/);
});

test('the 11-15 orphan: a new child recorded but the old one still alive and on :3456 → exit 3, named', async () => {
  const r = await restartRun({ restart: 'NEWCHILD(5151,200)' });
  assert.equal(r.code, 3);
  assert.doesNotMatch(r.out, /restarted/);
  assert.match(r.err, /old child 4242:100 is STILL ALIVE.*:3456 listeners are \[4242\], not only the new child 5151/);
});

test('no child on record before, an orphan still serving :3456 → exit 3 (no success without a proof)', async () => {
  const r = await restartRun({ before: 'mkdir -p $D/proc/9999; echo "9999 (node) S 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 50 0" > $D/proc/9999/stat; echo 9999 > $D/listener', restart: 'NEWCHILD(5151,200)' });
  assert.equal(r.code, 3);
  assert.match(r.err, /:3456 listeners are \[9999\], not only the new child 5151/);
});

test('a zombie replacement does not count as a new child → exit 3', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200,Z); LISTENER(5151)' });
  assert.equal(r.code, 3);
  assert.match(r.err, /no live new child recorded/);
});

test('a new child that does not answer → exit 3, the quota URL named', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200); LISTENER(5151)', quota: 503 });
  assert.equal(r.code, 3);
  assert.match(r.err, /teamclaude\/quota did not answer 200 in time/);
});

test('an answer that only comes after the deadline is not a proof → exit 3', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200); LISTENER(5151)', delayMs: 6000 });
  assert.equal(r.code, 3);
});

test('the child record never changes (restart did nothing) → exit 3', async () => {
  const r = await restartRun({ restart: 'true' });
  assert.equal(r.code, 3);
  assert.match(r.err, /old child 4242:100 is STILL ALIVE.*the child did not change/);
});

test('the old child exits a moment after the record changes → still verified within the window', async () => {
  const r = await restartRun({ restart: 'NEWCHILD(5151,200); LISTENER(5151); (sleep 1; rm -rf $D/proc/4242) &' });
  assert.equal(r.code, 0, r.err);
});

test('the same pid reused by a new child (new start time) counts as a new child', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(4242,999); LISTENER(4242)' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /new child 4242:999 alone on :3456/);
});

test('wait phase never idle → exit 1, no restart attempted', async () => {
  const r = await restartRun({ restart: 'touch $D/restarted', idle: 'false', phase: 'wait' });
  assert.equal(r.code, 1);
  assert.match(r.err, /never at 0 in-flight/);
  assert.equal(existsSync(join(r.dir, 'restarted')), false);
});

test('wait phase idle → exit 0 and nothing restarted (the restart is the second phase)', async () => {
  const r = await restartRun({ restart: 'touch $D/restarted', phase: 'wait' });
  assert.equal(r.code, 0);
  assert.equal(existsSync(join(r.dir, 'restarted')), false);
});

test('restart phase busy → exit 10 at once, no waiting, nothing restarted', async () => {
  const t0 = Date.now();
  const r = await restartRun({ restart: 'touch $D/restarted', idle: 'false' });
  assert.equal(r.code, 10);
  assert.match(r.err, /busy again at the restart moment/);
  assert.ok(Date.now() - t0 < 1500, 'did not wait for idle');
  assert.equal(existsSync(join(r.dir, 'restarted')), false);
});

test('the new child plus an orphan both on :3456 (different addresses) → exit 3, both named', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200); LISTENER(5151 9999)' });
  assert.equal(r.code, 3);
  assert.match(r.err, /:3456 listeners are \[5151 9999\], not only the new child 5151/);
});

test('an unreadable child record before the restart → refuse to restart (exit 3, nothing restarted)', async () => {
  const r = await restartRun({ before: 'echo garbage > $D/child_pid', restart: 'echo RESTARTED >&2' });
  assert.equal(r.code, 3);
  assert.match(r.err, /cannot identify the current child/);
  assert.doesNotMatch(r.err, /RESTARTED/);
});

test('a record whose pid is already gone before the restart counts as "none on record"', async () => {
  const r = await restartRun({ before: 'mkdir -p $D/proc; echo 4242 > $D/child_pid', restart: 'NEWCHILD(5151,200); LISTENER(5151)' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /old child none on record gone, new child 5151:200/);
});

test('a respawn while the quota answer is in flight: the answer is not credited to the new record → exit 3', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200); LISTENER(5151)', onRequest: 'NEWCHILD(6161,300)', delayMs: 300 });
  assert.equal(r.code, 3);
  assert.match(r.err, /:3456 listeners are \[5151\], not only the new child 6161/);
});

test('the respawn fixture is complete before the answer, however slow the edit (a loaded suite)', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200); LISTENER(5151)', onRequest: 'sleep 0.6; NEWCHILD(6161,300)', delayMs: 0 });
  assert.equal(r.code, 3);
  assert.match(r.err, /not only the new child 6161/);
});

test("the live VM's answer, the proxy's own 401 authentication_error (trustLoopback false), counts as serving", async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200); LISTENER(5151)', quota: 401, body: '{"type":"error","error":{"type":"authentication_error","message":"Invalid proxy API key"}}' });
  assert.equal(r.code, 0, r.err);
});

test('a bare 401 from something else does not count as serving → exit 3', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200); LISTENER(5151)', quota: 401, body: 'nope' });
  assert.equal(r.code, 3);
  assert.match(r.err, /did not answer 200 in time/);
});

test('an orphan opens :3456 while the answer is in flight: listener set re-checked after it → exit 3', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200); LISTENER(5151)', onRequest: 'LISTENER(5151 9999)', delayMs: 300 });
  assert.equal(r.code, 3);
  assert.match(r.err, /:3456 listeners are \[5151 9999\]/);
});

test('the old child still present but its stat unreadable is "could not be checked", never "gone" → exit 3', async () => {
  const r = await restartRun({ restart: 'NEWCHILD(5151,200); LISTENER(5151); rm -f $D/proc/4242/stat' });
  assert.equal(r.code, 3);
  assert.match(r.err, /old child 4242:100 could not be checked/);
});

test('a child record in a directory that cannot be searched → refuse to restart (unknown, not none)', async () => {
  const r = await restartRun({ before: 'mkdir -p $D/rec; echo 4242 > $D/rec/child_pid; chmod 000 $D/rec', restart: 'echo RESTARTED >&2', childFile: 'rec/child_pid' });
  assert.equal(r.code, 3);
  assert.match(r.err, /cannot identify the current child/);
});

test('a listener lookup that fails after printing the new pid is not a listener set → exit 3', async () => {
  const r = await restartRun({ restart: 'OLDGONE; NEWCHILD(5151,200); LISTENER(5151); echo "cat $D/listener; exit 1" > $D/lcmd' , listenerCmd: 'sh $D/lcmd' });
  assert.equal(r.code, 3);
  assert.match(r.err, /listener lookup failed or timed out/);
});

// ---------- JP's sittings (Sen 2026-11-16 11:4x: a drained restart still cut a live Squire sitting into a
// retryable 503). The whole script runs with a fake `ssh` first on PATH that records whether it was called.
async function gateRun(/** @type {{ flagAgeS?: number|null, args?: string[], ok?: boolean, onWait?: string, waitRc?: number, onRestart?: string, restartRcFirst?: number, setup?: (d: string, flag: string) => void }} */ o) {
  const d = mkdtempSync(join(tmpdir(), 'tc-sitting-'));
  mkdirSync(join(d, 'bin'));
  mkdirSync(join(d, 'state'));
  const flag = join(d, 'state', 'sitting.active');
  // the fake ssh logs each phase it is asked to run; during PHASE=wait it may run a fixture edit and exit waitRc
  writeFileSync(join(d, 'bin', 'ssh'), [
    '#!/bin/sh', 'cat >/dev/null', 'for a; do last=$a; done', `echo "$last" >> ${d}/ssh.args`,
    `case $last in *PHASE=wait*) echo wait >> ${d}/ssh.log; ${o.onWait ?? ':'}; exit ${o.waitRc ?? 0} ;; esac`,
    `echo restart >> ${d}/ssh.log`, `n=$(grep -c restart ${d}/ssh.log)`,
    `if [ "$n" = 1 ]; then ${o.onRestart ?? ':'}; exit ${o.restartRcFirst ?? 0}; fi`, 'exit 0', ''].join('\n'), { mode: 0o755 });
  if (o.flagAgeS != null) {
    writeFileSync(flag, '');
    const t = (Date.now() / 1000) - o.flagAgeS;
    utimesSync(flag, t, t);
  }
  o.setup?.(d, flag);
  try {
    return await new Promise(resolve => {
      const child = spawn('sh', [new URL('../scripts/vm-restart-idle.sh', import.meta.url).pathname, ...(o.args ?? [])], {
        env: { PATH: `${d}/bin:${process.env.PATH ?? ''}`, HOME: d, TC_SITTING_FLAG: flag, FLAG: flag, ...(o.ok ? { TC_SITTING_OK: '1' } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', c => { out += c; });
      child.stderr.on('data', c => { err += c; });
      child.on('exit', code => {
        const phases = existsSync(join(d, 'ssh.log')) ? readFileSync(join(d, 'ssh.log'), 'utf8').trim().split('\n') : [];
        resolve({ code, out, err, phases, sshArgs: existsSync(join(d, 'ssh.args')) ? readFileSync(join(d, 'ssh.args'), 'utf8') : '', sshCalled: phases.length > 0, restarted: phases.includes('restart') });
      });
    });
  } finally {
    // wait for the chmod itself, not a fixed 50 ms: a slow chmod left a 000 directory for rmSync
    await new Promise(r => spawn('chmod', ['-R', 'u+rwx', d]).on('exit', r));
    rmSync(d, { recursive: true, force: true });
  }
}

test('a JP sitting flag under 2 h old → exit 75, nothing restarted, "JP sitting since <time>; retry later"', async () => {
  const r = await gateRun({ flagAgeS: 600 });
  assert.equal(r.code, 75);
  assert.equal(r.sshCalled, false, 'the VM was never contacted');
  assert.match(r.err, /^JP sitting since \d\d:\d\d \S+; retry later/);
});

test('no sitting flag → wait phase, then the restart phase', async () => {
  const r = await gateRun({ flagAgeS: null });
  assert.equal(r.code, 0);
  assert.deepEqual(r.phases, ['wait', 'restart']);
});

test('a sitting flag over 2 h old is stale: warned, and the restart proceeds', async () => {
  const r = await gateRun({ flagAgeS: 7300 });
  assert.equal(r.restarted, true);
  assert.match(r.err, /stale sitting flag/);
});

test('a flag dated in the future still counts as a sitting (fail closed)', async () => {
  const r = await gateRun({ flagAgeS: -600 });
  assert.equal(r.code, 75);
  assert.equal(r.sshCalled, false);
});

test('a dangling flag symlink (start unreadable) counts as a sitting', async () => {
  const r = await gateRun({ setup: (d, flag) => symlinkSync(join(d, 'nowhere'), flag) });
  assert.equal(r.code, 75);
  assert.equal(r.sshCalled, false);
});

test('an old symlink to a fresh flag: the start time of its target counts (stat -L) → sitting', async () => {
  const r = await gateRun({ setup: (d, flag) => {
    writeFileSync(join(d, 'target'), '');
    symlinkSync(join(d, 'target'), flag);
    const old = (Date.now() / 1000) - 9000;
    spawnSync('touch', ['-h', '-d', `@${Math.floor(old)}`, flag]);
  } });
  assert.equal(r.code, 75);
  assert.equal(r.sshCalled, false);
});

test('a flag directory that cannot be searched is not proof of absence → sitting (fail closed)', async () => {
  const r = await gateRun({ flagAgeS: 60, setup: (d) => chmodSync(join(d, 'state'), 0o600) });
  if (process.getuid?.() === 0) return; // root searches anything
  assert.equal(r.code, 75);
  assert.equal(r.sshCalled, false);
  assert.match(r.err, /cannot be checked/);
});

test('a missing flag directory under a searchable parent is proved absent → restart proceeds', async () => {
  const r = await gateRun({ setup: (d) => rmSync(join(d, 'state'), { recursive: true }) });
  assert.deepEqual(r.phases, ['wait', 'restart']);
});

test('a sitting that starts during the idle wait is seen before the restart → exit 75, no restart phase', async () => {
  const r = await gateRun({ onWait: 'touch "$FLAG"' });
  assert.equal(r.code, 75);
  assert.deepEqual(r.phases, ['wait'], 'the restart phase never ran');
  assert.match(r.err, /^JP sitting since .*; retry later/);
});

test('busy again at the restart moment → back to the wait phase, the flag re-read: a sitting begun meanwhile stops it', async () => {
  const r = await gateRun({ restartRcFirst: 10, onRestart: 'touch "$FLAG"' });
  assert.equal(r.code, 75);
  assert.deepEqual(r.phases, ['wait', 'restart', 'wait']);
});

test('busy again at the restart moment, no sitting → wait and restart again', async () => {
  const r = await gateRun({ restartRcFirst: 10 });
  assert.equal(r.code, 0);
  assert.deepEqual(r.phases, ['wait', 'restart', 'wait', 'restart']);
});

test('the restart phase gets only the time left of the overall wait, never a fresh budget', async () => {
  const r = await gateRun({ args: ['jp@vm', '7'] });
  assert.equal(r.code, 0);
  const log = r.sshArgs.trim().split('\n');
  const waits = log.map(l => Number(/WAIT=(\d+)/.exec(l)?.[1]));
  assert.ok(waits.length === 2 && waits[1] <= 7 && waits[1] >= 1, `restart phase WAIT ${waits[1]} within the 7 s overall`);
});

test('the wait phase answers only at the deadline → exit 1, the restart phase never runs', async () => {
  const r = await gateRun({ args: ['jp@vm', '2'], onWait: 'sleep 3' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.phases, ['wait']);
  assert.match(r.err, /not restarted/);
});

test('a symlinked flag directory whose target is unsearchable is not proof of absence → sitting', async () => {
  if (process.getuid?.() === 0) return;
  const r = await gateRun({ setup: (d, flag) => {
    rmSync(join(d, 'state'), { recursive: true });
    mkdirSync(join(d, 'locked'));
    mkdirSync(join(d, 'locked', 'inner'));
    chmodSync(join(d, 'locked'), 0o600);
    symlinkSync(join(d, 'locked', 'inner'), join(d, 'state'));
  } });
  assert.equal(r.code, 75);
  assert.equal(r.sshCalled, false);
});

test('no idle moment in the wait phase → its exit code, no restart phase', async () => {
  const r = await gateRun({ waitRc: 1 });
  assert.equal(r.code, 1);
  assert.deepEqual(r.phases, ['wait']);
});

test('TC_SITTING_OK=1 overrides a sitting and says so', async () => {
  const r = await gateRun({ flagAgeS: 60, ok: true });
  assert.equal(r.restarted, true);
  assert.match(r.err, /TC_SITTING_OK=1: restarting despite: JP sitting since/);
});

test('--sitting reports the state for the restart notice and never restarts', async () => {
  const busy = await gateRun({ flagAgeS: 60, args: ['--sitting'] });
  assert.equal(busy.code, 75);
  assert.match(busy.out, /^JP sitting since/);
  assert.equal(busy.sshCalled, false);
  const free = await gateRun({ flagAgeS: null, args: ['--sitting'] });
  assert.equal(free.code, 0);
  assert.match(free.out, /^no JP sitting/);
  assert.equal(free.sshCalled, false);
});
