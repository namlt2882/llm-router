import { bandFor } from "./priceSchedule.js";

/**
 * The flat rate that applies to a request of `promptTokens`. A price row may carry
 * `tiers: [{ above, ...fields }]`: when the prompt is strictly over a tier's `above`, the highest such tier
 * replaces the base rate for EVERY token of the request (vendors bill long prompts that way).
 * A tier field it leaves out keeps the base value. A row without tiers is returned as is.
 * Works on any field naming (provider base rows and sale rows alike).
 */
export function priceForPrompt(row, promptTokens) {
  if (!row || !Array.isArray(row.tiers) || row.tiers.length === 0) return row;
  const n = Number(promptTokens) || 0;
  let hit = null;
  for (const t of row.tiers) if (n > t.above && (!hit || t.above > hit.above)) hit = t;
  const { tiers, ...base } = row;
  if (!hit) return base;
  const { above, ...rates } = hit;
  return { ...base, ...rates };
}

/** Sorted, de-duplicated tier thresholds of every row given. */
export function tierBreakpoints(...rows) {
  const set = new Set();
  for (const r of rows) for (const t of r?.tiers ?? []) set.add(t.above);
  return [...set].sort((a, b) => a - b);
}

/**
 * The rate a HOLD or quote reserves for a prompt that was only estimated. The real count can land across a
 * threshold the estimate did not, and a crossed tier reprices every token, so reserve the dearer (per field) of
 * the tier at the estimate and at `margin` times the estimate. Billing itself always uses the real count.
 */
export function priceForReserve(row, estimatedTokens, margin = 1.25) {
  const at = priceForPrompt(row, estimatedTokens);
  if (!row || !Array.isArray(row.tiers) || row.tiers.length === 0) return at;
  const hi = priceForPrompt(row, (Number(estimatedTokens) || 0) * margin);
  const out = { ...at };
  for (const [k, v] of Object.entries(hi)) if (typeof v === "number" && !(out[k] >= v)) out[k] = v;
  return out;
}

const TOKEN_KEYS = ["input", "cached", "output", "reasoning", "cache_creation", "cacheCreation"];
const scaled = (o, f) => {
  const out = { ...o };
  for (const k of TOKEN_KEYS) if (typeof out[k] === "number") out[k] *= f;
  return out;
};

/**
 * Resolve a row's `offPeak: { schedule, factor }` at time `at` (ms). Off-peak multiplies every token field, and every
 * tier's, by `factor`. No `at`, an unknown schedule or a factor outside (0, 1] means peak (the worst case). The
 * `offPeak` key is stripped; a row without it is returned as is.
 */
export function settleBand(row, at) {
  if (!row || !row.offPeak) return row;
  const { offPeak, ...rest } = row;
  const f = offPeak.factor;
  if (!(Number.isFinite(f) && f > 0 && f <= 1) || bandFor(offPeak.schedule, at) !== "offpeak") return rest;
  const out = scaled(rest, f);
  if (Array.isArray(rest.tiers)) out.tiers = rest.tiers.map((t) => scaled(t, f));
  return out;
}

/** The rate for a request of `promptTokens` that started at `at`: size tier first, then the time-of-day band. */
export function priceAt(row, { promptTokens, at } = {}) {
  return priceForPrompt(settleBand(row, at), promptTokens);
}
