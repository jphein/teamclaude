/** Resolve a subscription's quota capacity relative to a Claude Pro account. */
export function quotaTier(account) {
  const rateLimitTier = account.rateLimitTier || null;
  const seatTier = account.seatTier || null;
  const normalizedRate = String(rateLimitTier || '').toLowerCase();
  const normalizedSeat = String(seatTier || '').toLowerCase();

  let weight = null;
  if (normalizedRate.includes('20x') || normalizedRate.includes('x20') || normalizedSeat === 'team_tier_2') {
    weight = 20;
  } else if (normalizedRate.includes('5x') || normalizedRate.includes('x5') || normalizedSeat === 'team_tier_1') {
    weight = 5;
  } else if (normalizedSeat === 'team_standard'
      || normalizedRate === 'default_claude_ai'
      || account.organizationType === 'claude_pro'
      || account.hasClaudePro === true) {
    weight = 1;
  }

  return { rateLimitTier, seatTier, weight };
}

const BUCKETS = ['fiveHour', 'weeklyShared', 'weeklySonnet', 'weeklyFable'];

function clean(value) {
  return Math.round(value * 1e12) / 1e12;
}

function bucket(utilization, resetAt, source) {
  if (utilization == null) return null;
  const used = Number(utilization);
  if (!Number.isFinite(used)) return null;
  return {
    utilization: used,
    remaining: clean(Math.max(0, 1 - used)),
    resetAt: resetAt ?? null,
    source,
  };
}

// A third-party backend window (src/backend-quota.js) fills in where no
// unified field exists. An expired one is skipped, the same way
// refreshExpiredQuotas drops a stale unified reading.
//
// `observedAt` is when the probe took the reading (#510). A failed probe keeps
// the last good reading rather than blanking it, and a window with no reset
// never expires, so without its age a consumer cannot tell a fresh value from
// one that is hours old.
function backendWindow(/** @type {any} */ window, /** @type {string} */ source, /** @type {unknown} */ at) {
  if (!window || typeof window !== 'object') return null;
  if (window.resetAt != null && window.resetAt <= Date.now()) return null;
  const value = bucket(window.utilization, window.resetAt, source);
  return value && { ...value, observedAt: typeof at === 'number' && Number.isFinite(at) ? at : null };
}

function standardBucket(limit, remaining, resetAt, source) {
  if (limit == null || remaining == null || Number(limit) <= 0) return null;
  const value = bucket(1 - Number(remaining) / Number(limit), resetAt, source);
  return value && { ...value, limit: Number(limit), remainingAmount: Number(remaining) };
}

function accountBuckets(quota) {
  const shared = bucket(quota.unified7d, quota.unified7dReset, 'unified7d');
  const backend = quota.backend?.windows ?? null;
  const backendAt = quota.backend?.at;
  /** @type {Record<string, any>} */
  const buckets = {
    fiveHour: bucket(quota.unified5h, quota.unified5hReset, 'unified5h') ?? backendWindow(backend?.fiveHour, 'backendFiveHour', backendAt),
    weeklyShared: shared ?? backendWindow(backend?.weekly, 'backendWeekly', backendAt),
    weeklySonnet: bucket(
      quota.unified7dSonnet ?? quota.unified7d,
      quota.unified7dSonnet != null ? quota.unified7dSonnetReset : quota.unified7dReset,
      quota.unified7dSonnet != null ? 'unified7dSonnet' : 'unified7d',
    ),
    weeklyFable: bucket(
      quota.unified7dFable ?? quota.unified7d,
      quota.unified7dFable != null ? quota.unified7dFableReset : quota.unified7dReset,
      quota.unified7dFable != null ? 'unified7dFable' : 'unified7d',
    ),
  };
  // Anthropic reports only a 5h window's reset; it began five hours before it
  // (fork, for the seats tile and the stagger measurement). An inference, so
  // it rides beside resetAt rather than replacing anything reported.
  if (buckets.fiveHour?.source === 'unified5h' && buckets.fiveHour.resetAt != null && Number.isFinite(Number(buckets.fiveHour.resetAt))) {
    buckets.fiveHour = { ...buckets.fiveHour, windowStart: Number(buckets.fiveHour.resetAt) - 5 * 60 * 60 * 1000 };
  }
  // A monthly window exists only on third-party backends; like tokens and
  // requests, the key appears only when there is a reading.
  const monthly = backendWindow(backend?.monthly, 'backendMonthly', backendAt);
  if (monthly) buckets.monthly = monthly;
  const tokens = standardBucket(quota.tokensLimit, quota.tokensRemaining, quota.resetsAt, 'tokens');
  const requests = standardBucket(quota.requestsLimit, quota.requestsRemaining, quota.resetsAt, 'requests');
  if (tokens) buckets.tokens = tokens;
  if (requests) buckets.requests = requests;
  return buckets;
}

function aggregateBucket(accounts, key) {
  let capacityWeight = 0;
  let usedWeight = 0;
  let remainingWeight = 0;
  let knownAccounts = 0;
  let nextResetAt = null;
  for (const account of accounts) {
    const weight = account.tier.weight;
    const value = account.buckets[key];
    // A backend reading never joins the fleet aggregates: its units are the
    // provider's own, whatever tier the config claims for the account.
    if (weight == null || value == null || String(value.source).startsWith('backend')) continue;
    const boundedUtilization = Math.max(0, Math.min(1, value.utilization));
    capacityWeight += weight;
    usedWeight += weight * boundedUtilization;
    remainingWeight += weight * (1 - boundedUtilization);
    knownAccounts++;
    if (value.resetAt != null && (nextResetAt == null || value.resetAt < nextResetAt)) {
      nextResetAt = value.resetAt;
    }
  }
  if (knownAccounts === 0) return null;
  return {
    capacityWeight: clean(capacityWeight),
    usedWeight: clean(usedWeight),
    remainingWeight: clean(remainingWeight),
    utilization: clean(usedWeight / capacityWeight),
    remaining: clean(remainingWeight / capacityWeight),
    knownAccounts,
    nextResetAt,
  };
}

/**
 * Build the quota payload shared by the control endpoint and status clients.
 * @param {any[]} accounts
 * @param {{ canServe?: (account: any) => boolean }} [opts] `canServe`: the proxy's own routing predicate
 *   (AccountManager passes `unavailableReason(account) == null`, the one `live_seats` counts with). Without it
 *   (a bare summary of stored accounts) only the enabled-and-week-not-spent rule below applies.
 */
export function buildQuotaSummary(accounts, { canServe } = {}) {
  const summaries = accounts
    .map(account => ({
      name: account.name,
      type: account.type,
      disabled: !!account.disabled,
      status: account.status,
      tier: quotaTier(account),
      buckets: accountBuckets(account.quota || {}),
    }));
  /** @type {Record<string, any>} */
  const aggregate = Object.fromEntries(BUCKETS.map(key => [key, aggregateBucket(summaries, key)]));
  // The 5h headroom the fleet can actually SERVE: a seat whose week is spent, or that is disabled, has
  // an empty 5h window that serves nothing. Same denominator as `remaining`. On 2026-11-16 the plain
  // figure read 84% while two of seven seats could serve (27%), and lanes read "room" as no wall.
  // With the proxy's predicate, a seat counts exactly when the proxy would route a request to it: the same call
  // live_seats counts with, so the two cannot drift (2026-11-21: claude5, throttled 10:15-10:45, counted as room
  // while every request was refused). Its 5h room still needs a known tier weight and a unified 5h reading:
  // unknown headroom is never counted, so a live seat with neither adds 0 (live_seats > 0, servable 0).
  if (aggregate.fiveHour) {
    let servable = 0;
    for (const [i, a] of summaries.entries()) {
      const w = a.tier?.weight, f = a.buckets?.fiveHour, wk = a.buckets?.weeklyShared;
      if (w == null || f == null || String(f.source).startsWith('backend')) continue;
      const used = Number(f.utilization);
      if (!Number.isFinite(used)) continue;
      if (canServe) {
        if (!canServe(accounts[i])) continue;
      } else {
        // a week that is spent OR unknown is not counted as room (an unknown week could be spent)
        const weekUsed = wk == null ? NaN : Number(wk.utilization);
        if (a.disabled || !Number.isFinite(weekUsed) || weekUsed >= 0.98) continue;
      }
      servable += w * (1 - Math.max(0, Math.min(1, used)));
    }
    aggregate.fiveHour.servableRemaining = clean(servable / aggregate.fiveHour.capacityWeight);
  }
  return {
    accounts: summaries,
    aggregate,
    unknownTiers: summaries
      .filter(account => account.type === 'oauth' && account.tier.weight == null)
      .map(account => ({
        name: account.name,
        rateLimitTier: account.tier.rateLimitTier,
        seatTier: account.tier.seatTier,
      })),
  };
}
