/**
 * Measured capacity rows for one provider's diagnostic card (patch #20
 * follow-up). Detected budgets are keyed by connection id — or by the
 * provider id itself when the entry was saved at provider level — so the
 * card's table collects the provider-keyed entry plus every CURRENT
 * connection of this provider; stale keys (deleted connections, other
 * providers) never render. Provider-key rows keep the settings key in
 * `connId` (the provider id) with `connName: null` and sort last (they are
 * the fallback that applies to all connections).
 * @param {{ providerId: string, connections: Array<{id: string, provider: string, name?: string}>, detectedBudgets: Record<string, Record<string, {budget: number, detectedAt: string}>> | null }} input
 * @returns {Array<{connId: string, connName: string | null, model: string, budget: number, detectedAt: string}>}
 */
export function providerDetectedRows({ providerId, connections, detectedBudgets }) {
  const map = detectedBudgets && typeof detectedBudgets === "object" ? detectedBudgets : {};
  const mine = new Map([[providerId, null]]);
  for (const c of connections || []) {
    if (c?.provider === providerId) mine.set(c.id, c.name || c.id);
  }
  const rows = [];
  for (const [connId, connName] of mine) {
    const models = map[connId] && typeof map[connId] === "object" ? map[connId] : {};
    for (const [model, v] of Object.entries(models)) {
      if (!v || typeof v !== "object" || !Number.isInteger(v.budget) || v.budget < 1) continue;
      rows.push({ connId, connName, model, budget: v.budget, detectedAt: v.detectedAt || null });
    }
  }
  rows.sort((a, b) => {
    // provider-level rows (connName null) sort last, within a connection by model
    if ((a.connName === null) !== (b.connName === null)) return a.connName === null ? 1 : -1;
    if (a.connName !== b.connName) return String(a.connName).localeCompare(String(b.connName));
    return a.model.localeCompare(b.model);
  });
  return rows;
}
