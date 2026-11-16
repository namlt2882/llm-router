/**
 * Model list for the capacity-scan diagnostic picker (patch #20 follow-up).
 * The static catalog alone undercounts providers whose real catalog arrives
 * live: opencode free declares 4 models but serves dozens via `modelsFetcher`,
 * which the page surfaces as "suggested" chips — and those never reached the
 * picker. The merge is catalog-first (its order and names win), suggested
 * entries appended in their own order, deduped by id. Entries normalize to
 * `{ id, name }` (strings become their own name); input arrays are not mutated.
 * @param {Array<string | {id: string, name?: string}> | null} catalogModels
 * @param {Array<string | {id: string, name?: string}> | null} suggestedModels
 * @returns {Array<{id: string, name: string}>}
 */
export function diagnosticModelOptions(catalogModels, suggestedModels) {
  const out = [];
  const seen = new Set();
  for (const m of [...(catalogModels || []), ...(suggestedModels || [])]) {
    const id = typeof m === "string" ? m : m?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: (typeof m === "string" ? m : m?.name) || id });
  }
  return out;
}
