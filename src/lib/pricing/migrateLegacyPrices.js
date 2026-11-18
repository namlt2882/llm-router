import { listSalePrices, updateSalePrice } from "@/lib/db/repos/salePriceRepo.js";
import { toUsdRow } from "@/lib/pricing/priceUnit.js";

/** Rewrite every legacy credit row (no `unit: "usd"`) as a USD row at `rate`. Returns how many rows were written. */
export async function migrateLegacyPrices({ rate, list = listSalePrices, update = updateSalePrice }) {
  if (!Number.isFinite(rate) || !(rate > 0)) return 0;
  let written = 0;
  for (const row of await list()) {
    if (row.unit === "usd") continue;
    await update(row.name, (current) => {
      if (!current || current.unit === "usd") return undefined;
      written++;
      return toUsdRow(current, rate);
    });
  }
  return written;
}
