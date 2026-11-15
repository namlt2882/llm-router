/**
 * Fanout combo budget helpers (fork patch #19; docs/wavebot-patches.md).
 *
 * A combo can opt into fanout account selection via
 * `settings.comboStrategies[name].fanout = { enabled: true, budgets: { <connectionId>: <int> } }`.
 * While the in-flight cap (patch #5) applies one global limit to every
 * account, fanout gives each account its own budget, so the pool a combo can
 * use is the SUM of budgets instead of the max of one account. Ranking is by
 * headroom ratio — with different budgets per account, "fewest absolute
 * in-flight" is no longer the emptiest account.
 *
 * The wire shape is the RAW settings object: chat.js threads it unparsed, and
 * this module is the single place that validates it (auth.js calls
 * parseFanoutCtx). Invalid budgets fall back to the global limit rather than
 * erroring — a bad number must never make a combo unroutable.
 */

/**
 * Parse the raw combo fanout config into `{ budgets }`, or null when the
 * combo did not opt in. `enabled` must be exactly true; a budget counts only
 * when it is an integer >= 1 — 0, "3", 2.5 and negatives are dropped (they
 * fall back to the global limit at use time). An absent or empty budgets map
 * is valid: every account then runs at the global limit, and ranking is still
 * fanout's.
 * @param {{enabled?: unknown, budgets?: unknown}|null|undefined} cfg
 * @returns {{ budgets: Record<string, number> } | null}
 */
export function parseFanoutCtx(cfg) {
  if (!cfg || typeof cfg !== "object" || cfg.enabled !== true) return null;
  const raw = cfg.budgets && typeof cfg.budgets === "object" && !Array.isArray(cfg.budgets) ? cfg.budgets : {};
  const budgets = {};
  for (const [id, value] of Object.entries(raw)) {
    if (Number.isInteger(value) && value >= 1) budgets[id] = value;
  }
  return { budgets };
}

/**
 * Effective per-connection in-flight budget for a fanout request: the parsed
 * ctx's entry for the connection, else the global limit.
 * @param {{ budgets: Record<string, number> }|null} fanoutCtx
 * @param {string} connectionId
 * @param {number} globalLimit
 * @returns {number}
 */
export function effectiveFanoutBudget(fanoutCtx, connectionId, globalLimit) {
  const own = fanoutCtx?.budgets?.[connectionId];
  return Number.isInteger(own) && own >= 1 ? own : globalLimit;
}

/**
 * Rank fanout candidates by how much of their own budget is free, descending;
 * ties break by backoff level (least punished first), then by oldest use
 * (never-used first, like spread's recency), then by priority (lowest first).
 * Returns a new sorted array; the input is not mutated.
 * @param {{id: string, budget: number, inflight: number, backoffLevel?: number, lastUsedAt?: string, priority?: number}[]} rows
 * @returns {typeof rows}
 */
export function rankFanout(rows) {
  const recency = (r) => {
    const t = Date.parse(r.lastUsedAt || "");
    return Number.isFinite(t) ? t : 0; // never used sorts first
  };
  const freeRatio = (r) => 1 - r.inflight / r.budget;
  return [...rows].sort((a, b) =>
    freeRatio(b) - freeRatio(a) // most free budget first (descending)
    || (a.backoffLevel || 0) - (b.backoffLevel || 0)
    || recency(a) - recency(b)
    // nullish, not falsy: priority 0 is the HIGHEST priority and must keep it.
    || (a.priority ?? 999) - (b.priority ?? 999));
}

/**
 * Whether a combo-strategy entry routes as fanout. The canonical form is the
 * strategy value — `fallbackStrategy === "fanout"` in the dropdown (ruling
 * 2026-11-15: fanout is one combo strategy, not an additive checkbox).
 * Legacy checkbox entries (`fanout.enabled === true` on any strategy) keep
 * working so existing settings don't silently change behavior.
 * @param {{fallbackStrategy?: unknown, fanout?: unknown}|null|undefined} entry
 * @returns {boolean}
 */
export function isFanoutEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  return entry.fallbackStrategy === "fanout" || entry.fanout?.enabled === true;
}

/**
 * Derive the fanout ctx auth.js consumes (`{ enabled: true, budgets }`) from
 * a combo-strategy entry, or null when the entry is not fanout. Budgets go
 * through parseFanoutCtx's sanitization; the strategy value already says
 * fanout, so `enabled` is forced true regardless of any stale legacy flag.
 * @param {Parameters<isFanoutEntry>[0]} entry
 * @returns {{ budgets: Record<string, number> } | null}
 */
export function fanoutCtxForEntry(entry) {
  if (!isFanoutEntry(entry)) return null;
  const fanout = entry.fanout && typeof entry.fanout === "object" ? entry.fanout : {};
  const parsed = parseFanoutCtx({ ...fanout, enabled: true });
  // The wire shape auth.js re-parses: raw `{ enabled, budgets }`, not the
  // parsed ctx parseFanoutCtx returns.
  return { enabled: true, budgets: parsed.budgets };
}
