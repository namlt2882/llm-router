import { listSalePrices } from "@/lib/db/repos/salePriceRepo.js";
import { costFloor, defaultContext } from "@/lib/pricing/validateSalePrice.js";
import { effectiveUsdPrice, resolveStored } from "@/lib/pricing/effectiveSalePrice.js";
import { belowFloor } from "@/lib/pricing/bulkPrice.js";
import { toUsdRow } from "@/lib/pricing/priceUnit.js";

const statusOf = (live) => (live ? (live.source === "promo" ? "promo" : live.source === "markup" ? "markup" : "custom") : "auto");

/** One row per name: floor, the live stored row, what it sells for now, and its status. */
export async function listPrices({ names, stored = listSalePrices, ctx = defaultContext, now = Date.now() }) {
  const c = typeof ctx === "function" ? await ctx() : ctx;
  const rowsByName = new Map((await stored()).map((r) => [r.name, toUsdRow(r, c.rate)]));
  const all = [...new Set([...names, ...rowsByName.keys()])].sort();
  const out = [];
  for (const name of all) {
    const raw = rowsByName.get(name) ?? null;
    const live = resolveStored(raw, now);
    const kind = (await c.comboModels(name)) ? "combo" : "model";
    const { floor, defaulted } = await costFloor(name, kind, c);
    const effective = await effectiveUsdPrice(name, { stored: async () => raw, ctx: c, now });
    const row = {
      name,
      kind,
      floor: floor ?? null,
      defaultBase: !!defaulted,
      stored: live,
      effective,
      status: effective ? statusOf(live) : "no_base_price",
      belowFloor: live ? await belowFloor(live, c) : false,
    };
    if (live?.source === "promo") row.endsAt = live.endsAt;
    out.push(row);
  }
  return out;
}
