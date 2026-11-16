// Restart drain: on SIGTERM the proxy stops listening, lets every response already being delivered
// finish (a stream counts until its last byte: AccountManager.openStreams), turns new requests away
// with a retryable 503 (forwardRequest), and exits when nothing is open or the deadline passes.
// 2026-11-16: restarts cut live streams (Squire 08:35 "Connection lost mid-response") because shutdown
// closed every connection at once and the restart gate counted requests only until their headers.
//
// The deadline must stay below the service manager's TERM-to-KILL wait (OpenRC retry=TERM/<n>/KILL):
// drainSeconds defaults to 8 for the VM's TERM/10, and goes up only together with that wait.

export const DEFAULT_DRAIN_SECONDS = 8;

/**
 * @param {{ am: { openStreams: () => number, draining?: boolean }, closeListeners: () => void, closeAll: () => void,
 *   drainMs: number, pollMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void }} opts
 * @returns {Promise<{ drained: boolean, open: number, waitedMs: number }>}
 */
export async function drain({ am, closeListeners, closeAll, drainMs, pollMs = 250, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  const start = now();
  am.draining = true;
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
