/**
 * Pure helpers for the combos page's per-combo strategy settings
 * (settings.comboStrategies[name]). Kept out of page.js so the merge rules —
 * in particular the patch-#19 rules for when a fanout key survives a merge —
 * are unit-testable without a React test harness.
 */

/**
 * Merge a per-combo strategy patch into the entry currently stored for a
 * combo. Fanout is a combo STRATEGY value now: the fanout key survives only
 * while the entry routes as fanout — either the strategy value says "fanout",
 * or a legacy checkbox entry (fanout.enabled === true, no strategy change in
 * the patch) that has not been moved to another strategy. Switching the
 * strategy away from fanout therefore drops the budgets, so fanout can never
 * conflict with the selected strategy. `patch.fanout === null` removes the
 * key; a stored fanout that never had enabled === true is stale and dropped.
 * Returns the next entry, or null when nothing meaningful remains (fallback
 * strategy absent or at the default "fallback" AND no fanout) — the caller
 * deletes the settings entry.
 * @param {Record<string, unknown>|null|undefined} currentEntry
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>|null}
 */
export function mergeStrategyPatch(currentEntry, patch) {
  const next = { ...(currentEntry || {}), ...patch };
  if (patch.fanout === null) delete next.fanout;
  // Patch-aware on purpose: isFanoutEntry(next) alone would keep a legacy
  // entry's fanout key even when THIS patch just moved it to another strategy.
  const keepFanout = next.fallbackStrategy === "fanout"
    || (next.fanout?.enabled === true && patch.fallbackStrategy === undefined);
  if (!keepFanout) delete next.fanout;
  const fallbackAtDefault = !next.fallbackStrategy || next.fallbackStrategy === "fallback";
  if (fallbackAtDefault && !next.fanout) return null;
  return next;
}

/**
 * Provider ids referenced by combo members, for the fanout budget editor.
 * A member with a "/" contributes the part before the first slash; a member
 * naming another combo recurses into its models (depth-capped, cycle-safe);
 * plain model names contribute nothing — their accounts show no budget row.
 * comboByName is the page's map: combo name → models ARRAY (or a legacy
 * `{models}` object).
 * @param {string[]} members
 * @param {Record<string, string[]|{models?: string[]}>} comboByName
 * @param {number} depth
 * @returns {Set<string>}
 */
export function memberProviders(members, comboByName, depth = 0) {
  const out = new Set();
  if (!Array.isArray(members) || depth >= 3) return out;
  for (const member of members) {
    if (!member || typeof member !== "string") continue;
    if (comboByName?.[member]) {
      const nested = comboByName[member];
      const models = Array.isArray(nested) ? nested : nested?.models;
      for (const id of memberProviders(models, comboByName, depth + 1)) out.add(id);
      continue;
    }
    const idx = member.indexOf("/");
    if (idx > 0) out.add(member.slice(0, idx));
  }
  return out;
}

/**
 * Connections that get a budget row in the fanout editor. A member is written
 * with the provider's PREFIX ("fnt/model-id" for a custom endpoint,
 * "openai/gpt-4" for a registry provider), while a connection identifies as
 * either that prefix (`provider` for registry providers) or a dynamic id with
 * the prefix in `providerSpecificData.prefix` (custom endpoints) — accept both.
 * @param {Array<{provider?: string, providerSpecificData?: {prefix?: string}}>|null} activeProviders
 * @param {string[]} members
 * @param {Record<string, string[]|{models?: string[]}>} comboByName
 * @returns {Array}
 */
export function fanoutBudgetRows(activeProviders, members, comboByName) {
  const wanted = memberProviders(members, comboByName);
  return (activeProviders || []).filter((c) => wanted.has(c?.provider) || wanted.has(c?.providerSpecificData?.prefix));
}
