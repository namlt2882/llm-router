import { getSalePrice } from "@/lib/db/repos/salePriceRepo.js";
import { costFloor, defaultContext } from "@/lib/pricing/validateSalePrice.js";

/**
 * The price a name is sold at: the stored sale price when one is set, otherwise the cost floor
 * (dearest leaf base x FX floor rate, which already carries the FX margin), flagged `auto: true`.
 * null = not sellable: no base pricing, a combo cycle, or no FX rate.
 */
export async function effectiveSalePrice(name, { stored = getSalePrice, ctx = defaultContext } = {}) {
  const explicit = await stored(name);
  if (explicit) return explicit;
  let c;
  try {
    c = typeof ctx === "function" ? await ctx() : ctx;
  } catch {
    return null;
  }
  const kind = (await c.comboModels(name)) ? "combo" : "model";
  const { floor, error } = await costFloor(name, kind, c);
  if (error) return null;
  return { name, kind, auto: true, ...floor, perImage: 0 };
}
