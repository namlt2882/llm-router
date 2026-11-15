/**
 * Pure helpers for the combos page's per-combo strategy settings
 * (settings.comboStrategies[name]). Kept out of page.js so the merge rules —
 * in particular the patch-#19 rule that a fanout-enabled entry survives the
 * "default fallback strategy" prune — are unit-testable without a React
 * test harness.
 */

/**
 * Merge a per-combo strategy patch into the entry currently stored for a
 * combo. `patch.fanout === null` removes the key; a stored fanout whose
 * `enabled` is not true is stale and dropped as well. Returns the next entry,
 * or null when nothing meaningful remains (fallback strategy absent or at the
 * default "fallback" AND no fanout) — the caller deletes the settings entry.
 * @param {Record<string, unknown>|null|undefined} currentEntry
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>|null}
 */
export function mergeStrategyPatch(currentEntry, patch) {
  const next = { ...(currentEntry || {}), ...patch };
  if (!next.fanout || next.fanout.enabled !== true) delete next.fanout;
  const fallbackAtDefault = !next.fallbackStrategy || next.fallbackStrategy === "fallback";
  if (fallbackAtDefault && !next.fanout) return null;
  return next;
}

/**
 * Provider ids referenced by combo members, for the fanout budget editor.
 * A member with a "/" contributes the part before the first slash; a member
 * naming another combo recurses into its models (depth-capped, cycle-safe);
 * plain model names contribute nothing — their accounts show no budget row.
 * @param {string[]} members
 * @param {Record<string, {models?: string[]}>} comboByName
 * @param {number} depth
 * @returns {Set<string>}
 */
export function memberProviders(members, comboByName, depth = 0) {
  const out = new Set();
  if (!Array.isArray(members) || depth >= 3) return out;
  for (const member of members) {
    if (!member || typeof member !== "string") continue;
    if (comboByName?.[member]) {
      for (const id of memberProviders(comboByName[member].models, comboByName, depth + 1)) out.add(id);
      continue;
    }
    const idx = member.indexOf("/");
    if (idx > 0) out.add(member.slice(0, idx));
  }
  return out;
}
