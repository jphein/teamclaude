// The automatic banked-reset rules beyond the pool-dry spend (JP 2026-11-16 08:26: "come up with our
// automatic reset strategy"; Sen's strategy, items 3 and 3a). A pure decision over what the proxy
// already knows: the seat's quota, the last reset probe's id-free reading, the pool's 5-hour headroom.
// It never spends. The redeemer (claude-resets.js redeemByRule) re-reads the seat live and re-checks
// before any claim, so a stale reading here costs at most one zero-spend status read.
//
//  - 'expiry': a reset that clears the weekly and EXPIRES before the seat's own week resets would be
//    lost unspent, so spend it while it still buys something: at a work-block start (the first request
//    after >= 30 min idle) once the seat's weekly use is >= 60 %.
//  - 'five-hour': only when the fleet is actually waiting on 5-hour walls: this seat is at its 5-hour
//    wall, its week still has room (< 70 % used) and the pool's 5-hour remaining is under 20 %; spends a
//    reset that clears the 5-hour window but NOT the weekly (a weekly-clearing reset is never burnt on
//    a 5-hour wall).
// Both: only the seat's next grant (upstream spends only next_grant_id), usable now, and at most one
// rule spend per seat per 24 h (enforced by the redeemer, with the fleet hold and its cooldowns).

export const WORK_BLOCK_IDLE_MS = 30 * 60_000;
export const EXPIRY_MIN_WEEKLY = 0.6;
export const FIVE_HOUR_MAX_WEEKLY = 0.7;
export const FIVE_HOUR_POOL_BELOW = 0.2;
const AT_WALL = 0.98;

/**
 * @param {{ quota?: Record<string, any> }} account
 * @param {{ now: number, kept: { eligible?: boolean, grants?: Array<{ next?: boolean, usable?: boolean, clearsWeekly?: boolean, clears?: string[], resetsLeft?: number, endsAt?: number|null }> }|null|undefined, idleMs?: number|null, pool5hRemaining?: number|null }} ctx
 * @returns {{ rule: 'expiry'|'five-hour', reason: string }|null}
 */
export function ruleFor(account, { now, kept, idleMs = null, pool5hRemaining = null }) {
  if (!kept?.eligible) return null;
  const next = (kept.grants || []).find(g => g.next === true);
  if (!next || !next.usable || !(Number(next.resetsLeft) >= 1)) return null;
  if (next.endsAt != null && next.endsAt <= now) return null;
  const q = account?.quota || {};
  const weekly = num(q.unified7d);
  const weeklyReset = num(q.unified7dReset);

  if (next.clearsWeekly) {
    if (idleMs != null && idleMs < WORK_BLOCK_IDLE_MS) return null;
    if (weekly == null || weekly < EXPIRY_MIN_WEEKLY) return null;
    if (next.endsAt == null || weeklyReset == null || weeklyReset <= now || !(next.endsAt < weeklyReset)) return null;
    return { rule: 'expiry', reason: `its weekly reset expires before the seat's week resets, weekly at ${pct(weekly)}, work block starting` };
  }

  if (!(next.clears || []).includes('five_hour')) return null;
  const five = num(q.unified5h), fiveReset = num(q.unified5hReset);
  if (five == null || five < AT_WALL || fiveReset == null || fiveReset <= now) return null;
  if (weekly == null || weekly >= FIVE_HOUR_MAX_WEEKLY) return null;
  if (pool5hRemaining == null || !(pool5hRemaining < FIVE_HOUR_POOL_BELOW)) return null;
  return { rule: 'five-hour', reason: `at its 5-hour wall with weekly at ${pct(weekly)}, pool 5-hour at ${pct(1 - pool5hRemaining)} used` };
}

/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {number} v */
const pct = (v) => `${Math.round(v * 100)}%`;
