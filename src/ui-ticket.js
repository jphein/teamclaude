// One-time tickets that carry the operator's proxy key into the /ui page
// without the key ever appearing in a URL, a launcher file or shell history.
//
// A launcher on the operator's desktop presents the shared key once
// (POST /teamclaude/ui-ticket, operator-only) and gets a ticket back; it opens
// /ui?ticket=…; the page removes the ticket from the address bar before doing
// anything else and redeems it (POST /teamclaude/ui-ticket/redeem) for the key,
// which it keeps exactly as if it had been typed into the key box. The ticket
// in the browser's history is dead by then: single use, and short-lived.
//
// A ticket is bound to the key that minted it, so it can never be worth more
// than the request that asked for it. In memory only: a restart forgets them.

import { randomBytes } from 'node:crypto';

export const UI_TICKET_TTL_MS = 60_000;
export const UI_TICKET_MAX = 16;

/**
 * @param {{ ttlMs?: number, max?: number, now?: () => number, random?: () => string }} [opts]
 */
export function createUiTicketStore({
  ttlMs = UI_TICKET_TTL_MS,
  max = UI_TICKET_MAX,
  now = () => Date.now(),
  random = () => randomBytes(32).toString('base64url'),
} = {}) {
  /** @type {Map<string, { key: string, expires: number }>} */
  const tickets = new Map();

  function prune() {
    const t = now();
    for (const [id, entry] of tickets) if (entry.expires <= t) tickets.delete(id);
  }

  return {
    /** A fresh ticket for `key`, or null when too many are outstanding. @param {string} key */
    mint(key) {
      prune();
      if (tickets.size >= max) return null;
      const id = random();
      tickets.set(id, { key, expires: now() + ttlMs });
      return id;
    },
    /** The key a live ticket carries, consuming it; null for anything else. @param {unknown} id */
    redeem(id) {
      if (typeof id !== 'string' || id.length < 16 || id.length > 128) return null;
      const entry = tickets.get(id);
      if (!entry) return null;
      tickets.delete(id);       // single use, whether or not it is still in date
      return entry.expires > now() ? entry.key : null;
    },
    get size() { prune(); return tickets.size; },
  };
}
