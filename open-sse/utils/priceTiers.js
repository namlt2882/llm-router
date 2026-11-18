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
