// Routing decisions as a read-only JSON list (fork; JP 2026-11-10: "Teamclaude
// UI should be part of plan too"). The decisions a seat page needs — which
// seat the fleet moved to and why, windows starting and running out, the
// stagger's touches and skips, threshold and account changes — are written to
// the log, which only the operator can stream. This keeps the last few hundred
// of those lines in memory, so GET /teamclaude/events answers with the same
// keys that read /teamclaude/status, and a page can render them without
// tailing a log. Nothing here is persisted; a restart starts it empty.

export const MAX_EVENTS = 300;

// The decision lines, by the words they start with after "[TeamClaude] ".
// Each kind is the label a page can filter or colour by.
const KINDS = /** @type {[string, RegExp][]} */ ([
  ['switch', /^(Switched to account|Starting on account|Session pin on .* released)/],
  ['rebalance', /^Rebalanced /],
  ['refresh-routing', /^Refresh routing: /],
  ['window-start', /^Account "[^"]+" started a 5h window/],
  ['window-spent', /^Account "[^"]+" used up its 5h window/],
  ['session-reset', /^Account "[^"]+" session quota reset/],
  ['near-limit', /^Account "[^"]+" at [\d.]+% usage/],
  ['stagger', /^Keep-warm stagger: /],
  ['keep-warm', /^Keep-warm \(/],
  ['threshold', /^(Switch threshold |Account "[^"]+" \S+ threshold )/],
  ['account', /^(Account "[^"]+" (disabled|enabled|unlinked) |Add account started)/],
  ['reauth', /^Reauth(ed)? /],
  ['quota-429', /^(Quota rejection \(429\)|Rate-limit 429 on|Fable weekly exhausted on)/],
  ['exhausted', /^(All accounts exhausted|No account can serve|FAILOVER: )/],
]);

export class RoutingEvents {
  constructor(max = MAX_EVENTS, nowFn = Date.now) {
    this.max = max;
    this.nowFn = nowFn;
    /** @type {{ts: string, kind: string, text: string}[]} */
    this.events = [];
  }

  /** Record a log line if it is a routing decision. @param {string} line */
  note(line) {
    if (typeof line !== 'string') return;
    const m = /^\[TeamClaude\] (.*)$/s.exec(line);
    if (!m) return;
    const text = m[1].split('\n')[0].slice(0, 500);
    const kind = KINDS.find(([, re]) => re.test(text))?.[0];
    if (!kind) return;
    this.events.push({ ts: new Date(this.nowFn()).toISOString(), kind, text });
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
  }

  /** Newest last. @param {{since?: string|null, kind?: string|null, limit?: number}} [q] */
  list({ since = null, kind = null, limit = this.max } = {}) {
    const t = since ? Date.parse(since) : NaN;
    let out = this.events;
    if (Number.isFinite(t)) out = out.filter(e => Date.parse(e.ts) > t);
    if (kind) out = out.filter(e => e.kind === kind);
    const n = Math.max(1, Math.min(this.max, Number.isFinite(limit) ? Math.floor(limit) : this.max));
    return out.slice(-n);
  }

  /** Tee console.log into this buffer; returns the undo. */
  tapConsole() {
    const prev = console.log;
    const self = this;
    console.log = function (...a) {
      prev.apply(console, a);
      try { self.note(a.map(String).join(' ')); } catch { /* never break logging */ }
    };
    return () => { console.log = prev; };
  }
}
