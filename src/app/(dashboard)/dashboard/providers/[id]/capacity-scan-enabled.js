/**
 * Pure decision for the capacity scan's enabled flag when diagnostic models
 * are saved (patch #20, review minor 8). The map going empty→non-empty turns
 * the daily scan ON (the existing on-switch); the reverse — removing the last
 * model — now turns it OFF, so a scan with nothing to probe stops waking up.
 * Any other transition keeps the current value (undefined = caller omits the
 * field from the settings PATCH).
 * @param {Record<string, string[]> | null | undefined} prevMap
 * @param {Record<string, string[]> | null | undefined} nextMap
 * @returns {boolean | undefined}
 */
export function nextCapacityScanEnabled(prevMap, nextMap) {
  const any = (m) => Object.values(m || {}).some((v) => Array.isArray(v) && v.length > 0);
  const had = any(prevMap);
  const has = any(nextMap);
  if (has) return true;
  if (had) return false;
  return undefined;
}
