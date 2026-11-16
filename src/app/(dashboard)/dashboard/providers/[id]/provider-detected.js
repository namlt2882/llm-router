import { keylessLaneLimit } from "@/sse/services/fanoutBudget.js";

/**
 * Measured capacity rows for one provider's diagnostic card (patch #20
 * follow-up). Per Steve's ruling, the measured capacity is PER KEY: two keys
 * of the same provider can carry different subscriptions, so every row is one
 * connection's own measurement and the budget chain reads only
 * `detectedBudgets[connectionId][model]` — there is no provider aggregate,
 * and the card must not invent one. Stale keys (deleted connections, other
 * providers) never render. The one exception is a KEYLESS provider with no
 * connections: its single shared lane is measured under the provider id, so
 * that entry is shown as one "(toàn provider)" row.
 * `unbounded` marks a budget whose whole ramp passed (a floor, not a limit);
 * the keyless lane row also carries `applied`, the cap runtime really uses.
 * @param {{ providerId: string, connections: Array<{id: string, provider: string, name?: string}>, detectedBudgets: Record<string, Record<string, {budget: number, detectedAt: string, unbounded?: boolean}>> | null, keyless?: boolean, settings?: {keylessMaxInflight?: unknown} | null }} input
 * @returns {Array<{connId: string, connName: string, model: string, budget: number, detectedAt: string, unbounded: boolean, applied?: number}>}
 */
export function providerDetectedRows({ providerId, connections, detectedBudgets, keyless = false, settings = null }) {
  const map = detectedBudgets && typeof detectedBudgets === "object" ? detectedBudgets : {};
  const rows = [];
  const push = (id, name, lane = false) => {
    const models = map[id] && typeof map[id] === "object" ? map[id] : {};
    for (const [model, v] of Object.entries(models)) {
      if (!v || typeof v !== "object" || !Number.isInteger(v.budget) || v.budget < 1) continue;
      rows.push({
        connId: id, connName: name, model, budget: v.budget, detectedAt: v.detectedAt || null,
        unbounded: v.unbounded === true,
        ...(lane ? { applied: keylessLaneLimit(v.budget, settings) } : {}),
      });
    }
  };
  const own = (connections || []).filter((c) => c?.provider === providerId);
  for (const c of own) push(c.id, c.name || c.id);
  if (keyless && own.length === 0) push(providerId, "(toàn provider)", true);
  rows.sort((a, b) => {
    if (a.connName !== b.connName) return a.connName.localeCompare(b.connName);
    return a.model.localeCompare(b.model);
  });
  return rows;
}
