// Collapse a storm of identical log lines to one-per-window, carrying a count of
// how many repeats were suppressed since the last emit. Used for benign-but-noisy
// events like a client that doesn't trust our MITM CA retrying its handshake
// forever (a browser without the CA imported) — we want to know it's happening
// without drowning the journal in one line every few seconds.

export function makeLogThrottle({ windowMs = 60_000, now = () => Date.now() } = {}) {
  const seen = new Map(); // key → { last, suppressed }

  return (key) => {
    const t = now();
    const entry = seen.get(key);
    if (entry && t - entry.last < windowMs) {
      entry.suppressed++;
      return { log: false, suppressed: entry.suppressed };
    }
    const suppressed = entry ? entry.suppressed : 0; // report what we swallowed since last emit
    seen.set(key, { last: t, suppressed: 0 });
    return { log: true, suppressed };
  };
}
