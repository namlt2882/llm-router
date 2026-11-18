import { getSalePrice } from "@/lib/db/repos/salePriceRepo.js";
import { costFloor, defaultContext } from "@/lib/pricing/validateSalePrice.js";
import { toUsdRow, toCredits } from "@/lib/pricing/priceUnit.js";

/** A promotion row whose `endsAt` has passed stops applying: its `restore` row (or null = auto) takes over. */
export function resolveStored(row, now) {
  if (row && row.source === "promo" && row.endsAt <= now) return row.restore ?? null;
  return row ?? null;
}

async function resolveCtx(ctx) {
  try {
    return typeof ctx === "function" ? await ctx() : ctx;
  } catch {
    return null;
  }
}

async function usdFrom(name, resolved, ctx) {
  const c = await resolveCtx(ctx);
  if (!c) return null;
  if (resolved) return resolved.unit === "usd" ? resolved : Number.isFinite(c.rate) && c.rate > 0 ? toUsdRow(resolved, c.rate) : null;
  const kind = (await c.comboModels(name)) ? "combo" : "model";
  const { floor, error } = await costFloor(name, kind, c);
  if (error) return null;
  return { name, kind, unit: "usd", auto: true, ...floor, perImage: 0 };
}

/**
 * The price a name is sold at, in USD per 1M tokens: the stored row (a legacy credit row is converted at the
 * context rate) or the auto row at the cost floor (a combo's floor is the average of its members), flagged `auto: true`.
 * null = not sellable: no base pricing, a combo cycle, or no FX rate where one is needed.
 */
export async function effectiveUsdPrice(name, { stored = getSalePrice, ctx = defaultContext, now = Date.now() } = {}) {
  return usdFrom(name, resolveStored(await stored(name), now), ctx);
}

/**
 * The same price as the credit-shaped row the billing path reads (1 credit = 1 VND). A resolved legacy credit
 * row is returned untouched and needs no rate; null when a USD row or the auto price cannot get one.
 */
export async function effectiveSalePrice(name, { stored = getSalePrice, ctx = defaultContext, now = Date.now() } = {}) {
  const resolved = resolveStored(await stored(name), now);
  if (resolved && resolved.unit !== "usd") return resolved;
  const c = await resolveCtx(ctx);
  if (!c || !Number.isFinite(c.rate) || !(c.rate > 0)) return null;
  const usd = await usdFrom(name, resolved, c);
  return usd ? toCredits(usd, c.rate) : null;
}
