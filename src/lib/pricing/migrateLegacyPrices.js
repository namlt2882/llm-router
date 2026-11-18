import { listSalePrices, getSalePrice, setSalePrice } from "@/lib/db/repos/salePriceRepo.js";
import { toUsdRow } from "@/lib/pricing/priceUnit.js";

/** Rewrite every legacy credit row (no `unit: "usd"`) as a USD row at `rate`. Returns how many rows were written. */
export async function migrateLegacyPrices({ rate, list = listSalePrices, get = getSalePrice, set = setSalePrice }) {
  if (!Number.isFinite(rate) || !(rate > 0)) return 0;
  let written = 0;
  for (const row of await list()) {
    if (row.unit === "usd") continue;
    const current = await get(row.name);
    if (!current || current.unit === "usd") continue;
    await set(toUsdRow(current, rate));
    written++;
  }
  return written;
}
