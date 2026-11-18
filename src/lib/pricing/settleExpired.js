import { getSalePrice, listSalePrices, setSalePrice, removeSalePrice } from "@/lib/db/repos/salePriceRepo.js";

/**
 * Write expired promotions back to their restore row (or remove them). Each row is re-read just before
 * the write and settled only if it is still the same expired promotion, so a price saved after the
 * snapshot is never overwritten with a stale one.
 */
export async function settleExpired({ list = listSalePrices, get = getSalePrice, set = setSalePrice, remove = removeSalePrice, now = Date.now() } = {}) {
  for (const row of await list()) {
    if (row.source !== "promo" || row.endsAt > now) continue;
    const live = await get(row.name);
    if (!live || live.source !== "promo" || live.endsAt !== row.endsAt) continue;
    if (row.restore) await set({ ...row.restore, name: row.name });
    else await remove(row.name);
  }
}
