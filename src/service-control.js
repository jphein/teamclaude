// How the web dashboard reaches the service it runs under: where its log lives
// and how it restarts. The defaults are the systemd user unit `teamclaude
// service install` writes (journald + `systemctl --user restart`), and they
// are unchanged. A host without systemd — an Alpine/OpenRC VM, a container, a
// supervisor — names its own in `config.service`, and a host where neither is
// available gets a clear "not available here" instead of a dead button.
//
//   "service": {
//     "logs":    "journald" | { "file": "/var/log/teamclaude.log" } | false,
//     "restart": "systemd"  | { "command": ["rc-service", "teamclaude", "restart"] }
//                           | "exit" | false
//   }
//
// `restart.command` is an argv array, run without a shell: the config file is
// operator-owned, but nothing here should ever be a string a shell re-parses.
// `"exit"` ends the process with EXIT_FOR_RESTART and leaves the restart to
// whatever supervises it (OpenRC's supervise-daemon respawns, as does a
// systemd unit with Restart=on-failure, Docker's restart policy, runit, s6).

import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { UNIT_NAME } from './service.js';

/** Exit status for `restart: "exit"`: EX_TEMPFAIL, non-zero so that a
 * supervisor which restarts only on failure still restarts. */
export const EXIT_FOR_RESTART = 75;

/** How much of a log file's tail is read for the initial lines. */
const TAIL_BYTES = 64 * 1024;
/** Most bytes one poll reads; more growth than this is skipped to the tail. */
export const MAX_READ_BYTES = 256 * 1024;

/**
 * @typedef {{ kind: 'journald' } | { kind: 'file', path: string } | { kind: 'off', reason: string }} LogSource
 * @typedef {{ kind: 'command', argv: string[] } | { kind: 'exit' } | { kind: 'off', reason: string }} RestartMethod
 */

/**
 * The log source the dashboard tails. Invalid settings resolve to `off` with
 * the reason, rather than to a guess.
 * @param {any} config
 * @returns {LogSource}
 */
export function resolveLogSource(config) {
  const v = config?.service?.logs;
  if (v === undefined || v === null || v === 'journald') return { kind: 'journald' };
  if (v === false) return { kind: 'off', reason: 'log viewing is turned off (service.logs: false)' };
  if (typeof v === 'object' && typeof v.file === 'string' && v.file.trim()) return { kind: 'file', path: v.file.trim() };
  return { kind: 'off', reason: 'service.logs is not "journald", { "file": "<path>" } or false' };
}

/**
 * How the dashboard's Restart button restarts the service.
 * @param {any} config
 * @returns {RestartMethod}
 */
export function resolveRestartMethod(config) {
  const v = config?.service?.restart;
  if (v === undefined || v === null || v === 'systemd') return { kind: 'command', argv: ['systemctl', '--user', 'restart', UNIT_NAME] };
  if (v === 'exit') return { kind: 'exit' };
  if (v === false) return { kind: 'off', reason: 'restart is turned off (service.restart: false)' };
  if (typeof v === 'object' && Array.isArray(v.command) && v.command.length > 0
    && v.command.every(/** @param {unknown} a */ (a) => typeof a === 'string' && a.length > 0)) {
    return { kind: 'command', argv: [...v.command] };
  }
  return { kind: 'off', reason: 'service.restart is not "systemd", "exit", { "command": [argv…] } or false' };
}

/**
 * Start the restart command, detached so it outlives this process (it is about
 * to kill it). Resolves once the command has started — or failed to — so the
 * caller can answer honestly: a missing binary is "not available here" (501),
 * not a "restarting" that never happens.
 * @param {string[]} argv
 * @param {{ spawnFn?: typeof spawn }} [deps]
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export function startRestartCommand(argv, { spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
    } catch (err) {
      resolve({ ok: false, status: 500, error: `restart command failed to start: ${/** @type {any} */ (err).code || /** @type {any} */ (err).message}` });
      return;
    }
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
    child.once('error', (/** @type {any} */ err) => {
      resolve(err?.code === 'ENOENT'
        ? { ok: false, status: 501, error: `restart unavailable: "${argv[0]}" is not installed here; set service.restart` }
        : { ok: false, status: 500, error: `restart command failed to start: ${err?.code || err?.message}` });
    });
  });
}

/**
 * Split text into complete lines, returning the unterminated remainder.
 * @param {string} text
 */
export function splitLines(text) {
  const parts = text.split(/\r?\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts.filter(l => l.trim()), rest };
}

/**
 * Follow a log file the way `tail -n <lines> -F` does, in-process, so a host
 * needs no journalctl and no tail binary: the last `lines` lines first, then
 * every line appended after. A file that shrinks (truncated or rotated by
 * copy-truncate) is read again from the start; one that is replaced (rotated
 * by rename) is picked up by inode. A file that is missing or unreadable is
 * reported once through onError and retried, so a log that appears later is
 * still followed.
 *
 * Returns stop(). onLine is not called after stop().
 * @param {string} path
 * @param {{ lines?: number, pollMs?: number, onLine: (line: string) => void, onError?: (err: any) => void }} opts
 */
export function tailFile(path, { lines = 100, pollMs = 1000, onLine, onError = () => {} }) {
  let stopped = false;
  let offset = -1;      // -1: not yet positioned (first read takes the tail)
  /** @type {number | null} */
  let ino = null;
  let rest = '';
  let reportedError = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /** @param {number} from @param {number} to */
  const readRange = async (from, to) => {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      const { bytesRead } = await fh.read(buf, 0, buf.length, from);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const st = await stat(path);
      reportedError = false;
      if (offset === -1) {
        const from = Math.max(0, st.size - TAIL_BYTES);
        let text = await readRange(from, st.size);
        // Started mid-line: the first partial line is not a line.
        if (from > 0) text = text.slice(text.indexOf('\n') + 1);
        const split = splitLines(text);
        for (const l of split.lines.slice(-lines)) if (!stopped) onLine(l);
        rest = split.rest;
        offset = st.size;
        ino = st.ino;
      } else {
        if (st.ino !== ino || st.size < offset) { offset = 0; rest = ''; ino = st.ino; }
        if (st.size > offset) {
          // Bounded per poll: a log that grew by more than MAX_READ_BYTES since
          // the last look (a burst, or a file replaced by something huge) is
          // skipped to its tail with a marker, never read into one buffer.
          let from = offset;
          if (st.size - offset > MAX_READ_BYTES) {
            from = st.size - TAIL_BYTES;
            if (!stopped) onLine(`[TeamClaude] … ${from - offset} bytes of log skipped (grew faster than the viewer reads)`);
            rest = '';
          }
          let text = await readRange(from, st.size);
          if (from !== offset) text = text.slice(text.indexOf('\n') + 1);
          const split = splitLines(rest + text);
          offset = st.size;
          // An unterminated line is buffered only up to a bound, then dropped.
          rest = split.rest.length > TAIL_BYTES ? '' : split.rest;
          for (const l of split.lines) if (!stopped) onLine(l);
        }
      }
    } catch (err) {
      if (!reportedError) { reportedError = true; onError(err); }
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };
  tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
