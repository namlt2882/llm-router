/**
 * Measured capacity rows for one provider's diagnostic card (patch #20
 * follow-up). Per Steve's ruling, the measured capacity is PER KEY: two keys
 * of the same provider can carry different subscriptions, so every row is one
 * connection's own measurement and the budget chain reads only
 * `detectedBudgets[connectionId][model]` — there is no provider aggregate,
 * and the card must not invent one. Stale keys (deleted connections, other
 * providers) never render.
 * @param {{ providerId: string, connections: Array<{id: string, provider: string, name?: string}>, detectedBudgets: Record<string, Record<string, {budget: number, detectedAt: string}>> | null }} input
 * @returns {Array<{connId: string, connName: string, model: string, budget: number, detectedAt: string}>}
 */
export function providerDetectedRows({ providerId, connections, detectedBudgets }) {
  const map = detectedBudgets && typeof detectedBudgets === "object" ? detectedBudgets : {};
  const rows = [];
  for (const c of connections || []) {
    if (c?.provider !== providerId) continue;
    const models = map[c.id] && typeof map[c.id] === "object" ? map[c.id] : {};
    for (const [model, v] of Object.entries(models)) {
      if (!v || typeof v !== "object" || !Number.isInteger(v.budget) || v.budget < 1) continue;
      rows.push({ connId: c.id, connName: c.name || c.id, model, budget: v.budget, detectedAt: v.detectedAt || null });
    }
  }
  rows.sort((a, b) => {
    if (a.connName !== b.connName) return a.connName.localeCompare(b.connName);
    return a.model.localeCompare(b.model);
  });
  return rows;
}
