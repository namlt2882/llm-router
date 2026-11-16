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
 * Parse the raw combo fanout config into `{ budgets, percent }`, or null when
 * the combo did not opt in. `enabled` must be exactly true; a budget counts
 * only when it is an integer >= 1 — 0, "3", 2.5 and negatives are dropped
 * (they fall back to the resolved chain at use time). An absent or empty
 * budgets map is valid: every account then runs at its detected-or-global
 * level, and ranking is still fanout's. `percent` (the combo's margin on
 * detected budgets) is an integer 1–100; anything else parses as 100 — never
 * 0, so a typo can only widen the margin, never unroutable the combo.
 * @param {{enabled?: unknown, budgets?: unknown, percent?: unknown}|null|undefined} cfg
 * @returns {{ budgets: Record<string, number>, percent: number } | null}
 */
export function parseFanoutCtx(cfg) {
  if (!cfg || typeof cfg !== "object" || cfg.enabled !== true) return null;
  const raw = cfg.budgets && typeof cfg.budgets === "object" && !Array.isArray(cfg.budgets) ? cfg.budgets : {};
  const budgets = {};
  for (const [id, value] of Object.entries(raw)) {
    if (Number.isInteger(value) && value >= 1) budgets[id] = value;
  }
  const percent = Number.isInteger(cfg.percent) && cfg.percent >= 1 && cfg.percent <= 100 ? cfg.percent : 100;
  return { budgets, percent };
}

/**
 * Detected budget for one (connection, model) pair from the capacity scan
 * (`settings.detectedBudgets`), or null when that pair was never measured.
 * A measured quota is a REAL zero: the scan marks it `{budget:0, quota:true}`,
 * and it reads here as 0 so the model is excluded instead of falling back to
 * the global limit. A bare `budget:0` with no quota flag is still junk → null.
 * An untested model has NO budget — callers fall back to the global limit
 * (ruling 2026-11-16: no min-aggregate, no representative-model guessing).
 * @param {Record<string, Record<string, {budget?: unknown, quota?: unknown}>}|null|undefined} detected
 * @param {string} connectionId
 * @param {string} model
 * @returns {number | null}
 */
export function detectedBudgetFor(detected, connectionId, model) {
  const entry = detected?.[connectionId]?.[model];
  const value = entry?.budget;
  if (value === 0 && entry?.quota === true) return 0;
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Base per-account in-flight cap for EVERY strategy (ruling 2026-11-15):
 * the scan's measured (connection, model) budget, else the global limit.
 * @param {Parameters<detectedBudgetFor>[0]} detected
 * @param {string} connectionId
 * @param {string} model
 * @param {number} globalLimit
 * @returns {number}
 */
export function effectiveBaseCap(detected, connectionId, model, globalLimit) {
  return detectedBudgetFor(detected, connectionId, model) ?? globalLimit;
}

/**
 * Effective per-connection in-flight budget for a fanout request —
 * manual combo-entry budget (integer >= 1, exact and NEVER scaled) →
 * floor(detected[conn][model] × ctx.percent / 100), min 1 → global limit.
 * When `detected` or `model` is absent the chain is manual → global, which
 * keeps the historical 3-arg behavior for existing callers.
 * @param {{ budgets: Record<string, number>, percent?: number }|null} fanoutCtx
 * @param {string} connectionId
 * @param {number} globalLimit
 * @param {Parameters<detectedBudgetFor>[0]} [detected]
 * @param {string} [model]
 * @returns {number}
 */
export function effectiveFanoutBudget(fanoutCtx, connectionId, globalLimit, detected = null, model = null) {
  const own = fanoutCtx?.budgets?.[connectionId];
  if (Number.isInteger(own) && own >= 1) return own;
  if (detected && model) {
    const value = detectedBudgetFor(detected, connectionId, model);
    // A measured quota (0) stays 0: the caller excludes that model. Only a
    // positive detected budget is floored at 1 so percent never zeroes a real one.
    if (value === 0) return 0;
    if (value !== null) return Math.max(1, Math.floor((value * (fanoutCtx?.percent ?? 100)) / 100));
  }
  return globalLimit;
}

/** Default ceiling on a keyless (free, shared) lane's in-flight requests. */
export const KEYLESS_MAX_INFLIGHT = 6;

/**
 * Clamp a keyless lane's resolved budget to the lane ceiling. A free lane is
 * one shared upstream allowance, and a scan whose whole ramp passed only proves
 * "no limit seen" — so the ceiling bounds even a detected 32.
 * `settings.keylessMaxInflight` (integer >= 1) overrides the default of 6.
 * @param {number} budget the resolved per-lane budget
 * @param {{keylessMaxInflight?: unknown}|null|undefined} settings
 * @returns {number}
 */
export function keylessLaneLimit(budget, settings) {
  const own = settings?.keylessMaxInflight;
  const ceiling = Number.isInteger(own) && own >= 1 ? own : KEYLESS_MAX_INFLIGHT;
  return Math.min(budget, ceiling);
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
 * Derive the fanout ctx auth.js consumes (`{ enabled: true, budgets, percent }`)
 * from a combo-strategy entry, or null when the entry is not fanout. Budgets
 * and percent go through parseFanoutCtx's sanitization; the strategy value
 * already says fanout, so `enabled` is forced true regardless of any stale
 * legacy flag.
 * @param {Parameters<isFanoutEntry>[0]} entry
 * @returns {{ enabled: true, budgets: Record<string, number>, percent: number } | null}
 */
export function fanoutCtxForEntry(entry) {
  if (!isFanoutEntry(entry)) return null;
  const fanout = entry.fanout && typeof entry.fanout === "object" ? entry.fanout : {};
  const parsed = parseFanoutCtx({ ...fanout, enabled: true });
  // The wire shape auth.js re-parses: raw `{ enabled, budgets, percent }`, not
  // the parsed ctx parseFanoutCtx returns.
  return { enabled: true, budgets: parsed.budgets, percent: parsed.percent };
}
