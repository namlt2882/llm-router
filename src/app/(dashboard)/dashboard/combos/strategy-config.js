/**
 * Pure helpers for the combos page's per-combo strategy settings
 * (settings.comboStrategies[name]). Kept out of page.js so the merge rules —
 * in particular the patch-#19 rules for when a fanout key survives a merge —
 * are unit-testable without a React test harness. Fanout renders no per-
 * account UI on the card (ruling 2026-11-15): budgets live in the settings
 * entry and are honored at routing time, not edited on the card.
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
  // Patch #20: a patch that touches only fanout.percent must not clobber the
  // stored budgets — spread the fanout object instead of replacing it.
  if (patch.fanout && typeof patch.fanout === "object"
    && currentEntry?.fanout && typeof currentEntry.fanout === "object") {
    next.fanout = { ...currentEntry.fanout, ...patch.fanout };
  }
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
