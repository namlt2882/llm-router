import { getAdapter } from "../driver.js";

/** Read-only: what the router recorded for one WaveBot hold (null = never seen). */
export async function getUsageByHoldId(holdId) {
  if (!holdId) return null;
  const db = await getAdapter();
  const rows = db.all(`SELECT costCredits FROM usageHistory WHERE holdId = ?`, [String(holdId)]);
  if (rows.length === 0) return null;
  let costCredits = 0;
  for (const r of rows) {
    const n = Number(r.costCredits);
    if (Number.isFinite(n)) costCredits += n;
  }
  return { costCredits, attempts: rows.length };
}
