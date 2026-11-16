import { writeFileSync, renameSync, rmSync } from 'node:fs';

// Restart drain: on SIGTERM the proxy stops listening, lets every response already being delivered
// finish (a stream counts until its last byte: AccountManager.openStreams), turns new requests away
// with a retryable 503 (forwardRequest), and exits when nothing is open or the deadline passes.
// 2026-11-16: restarts cut live streams (Squire 08:35 "Connection lost mid-response") because shutdown
// closed every connection at once and the restart gate counted requests only until their headers.
//
// The deadline must stay below the service manager's TERM-to-KILL wait (OpenRC retry=TERM/<n>/KILL):
// drainSeconds defaults to 8 for the VM's TERM/10, and goes up only together with that wait.

export const DEFAULT_DRAIN_SECONDS = 8;

// The drain marker (ubox0 #127, 2026-11-16): the ubox0 watchdog restarts the service after two missed
// status probes, and a draining proxy no longer listens. While this file exists and is younger than
// 110 s the watchdog stands down. Its directory is created jp-owned by the VM's start_pre; on any host
// without that directory the marker is skipped quietly. Published atomically: a fresh temp file created
// exclusively (never opens a planted symlink or FIFO), then renamed over the marker path (rename replaces
// a symlink itself, never its target), so a failed write never leaves a marker that looks valid.
export const DRAIN_MARKER = '/var/lib/teamclaude/drain/draining';

/** @returns {boolean} true once the marker is in place @param {string} marker @param {(l: string) => void} log */
export function writeDrainMarker(marker, log) {
  const tmp = `${marker}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o644 });
    renameSync(tmp, marker);
    return true;
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    const code = /** @type {any} */ (e)?.code;
    if (code !== 'ENOENT') log(`[TeamClaude] Drain marker ${marker} not written (${code || 'error'}): the host watchdog may restart during this drain`);
    return false;
  }
}

/**
 * @param {{ am: { openStreams: () => number, draining?: boolean }, closeListeners: () => void, closeAll: () => void,
 *   drainMs: number, pollMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void,
 *   marker?: string|null }} opts
 * @returns {Promise<{ drained: boolean, open: number, waitedMs: number }>}
 */
export async function drain({ am, closeListeners, closeAll, drainMs, pollMs = 250, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, marker = null }) {
  const start = now();
  am.draining = true;
  // written before the listeners close, so no watchdog probe can miss without the marker in place
  const marked = marker ? writeDrainMarker(marker, log) : false;
  try {
    return await drainBody({ am, closeListeners, closeAll, drainMs, pollMs, now, sleep, log, start });
  } finally {
    if (marked) { try { rmSync(/** @type {string} */ (marker), { force: true }); } catch { /* best effort */ } }
  }
}

/** @param {any} o */
async function drainBody({ am, closeListeners, closeAll, drainMs, pollMs, now, sleep, log, start }) {
  try { closeListeners(); } catch { /* already closed */ }
  let open = am.openStreams();
  if (open > 0) log(`[TeamClaude] Draining: ${open} open stream${open === 1 ? '' : 's'}, up to ${Math.round(drainMs / 1000)}s`);
  while (open > 0 && now() - start < drainMs) {
    await sleep(Math.max(1, Math.min(pollMs, drainMs - (now() - start))));
    open = am.openStreams();
  }
  const waitedMs = now() - start;
  if (open > 0) log(`[TeamClaude] Drain deadline: ${open} stream${open === 1 ? '' : 's'} still open after ${Math.round(waitedMs / 1000)}s; closing`);
  else if (waitedMs > 0) log(`[TeamClaude] Drained in ${(waitedMs / 1000).toFixed(1)}s`);
  try { closeAll(); } catch { /* already closed */ }
  return { drained: open === 0, open, waitedMs };
}

/** drainSeconds from the config: a non-negative number, else the default. @param {any} config */
export function drainMsFrom(config) {
  const raw = config?.drainSeconds;
  const s = typeof raw === 'number' ? raw : NaN; // unset, null or a string is the default, never 0
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_DRAIN_SECONDS) * 1000;
}
