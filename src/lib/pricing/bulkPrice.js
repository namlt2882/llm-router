import { getSalePrice, setSalePrice, removeSalePrice } from "@/lib/db/repos/salePriceRepo.js";
import { costFloor, validateSalePrice } from "@/lib/pricing/validateSalePrice.js";
import { effectiveSalePrice, resolveStored } from "@/lib/pricing/effectiveSalePrice.js";

const FIELDS = ["input", "output", "cached", "reasoning", "cacheCreation", "perImage"];
const TOKEN_FIELDS = FIELDS.slice(0, 5);
const EPS = 1e-12;

/** True when any token field sits under the cost floor; false when the name has no floor. */
export async function belowFloor(price, ctx) {
  const { floor, error } = await costFloor(price.name, price.kind, ctx);
  if (error) return false;
  return TOKEN_FIELDS.some((f) => price[f] < floor[f]);
}

const isActivePromo = (row, now) => !!row && row.source === "promo" && row.endsAt > now;

function scale(base, factor, round) {
  const out = {};
  for (const f of FIELDS) out[f] = round((Number(base[f] ?? 0) * factor) / 100);
  return out;
}

// Float noise (25000 * 110 / 100 = 27500.000000000004) must not push a ceil up a whole credit.
const ceil = (x) => Math.ceil(x * (1 - EPS));

/**
 * Apply a markup, a timed promotion, or a revert to many names at once by writing stored prices.
 * One name failing never blocks the others; each reports its own result.
 */
export async function applyBulk(
  { action, names, pct, label, endsAt },
  { stored = getSalePrice, save = setSalePrice, drop = removeSalePrice, ctx, now = Date.now() } = {},
) {
  const results = [];
  for (const name of [...new Set(names)]) {
    try {
      results.push(await applyOne(name));
    } catch (e) {
      results.push({ name, ok: false, error: e?.message || "failed" });
    }
  }
  return { results };

  async function applyOne(name) {
    const raw = await stored(name);
    if (action === "revert") {
      const back = raw?.source === "promo" ? (raw.restore ?? null) : null;
      if (back) await save(back);
      else if (raw) await drop(name);
      return { name, ok: true };
    }
    if (action === "markup" && isActivePromo(raw, now)) return { name, ok: false, error: "in_promotion" };

    const current = resolveStored(raw, now);
    const promoActive = action === "promo" && isActivePromo(raw, now);
    const prior = promoActive ? (raw.restore ?? null) : current;
    const base = prior ?? (await effectiveSalePrice(name, { stored: async () => null, ctx, now }));
    if (!base) return { name, ok: false, error: "unsellable" };

    const core = { name, kind: base.kind };
    if (action === "markup") {
      const price = { ...core, ...scale(base, 100 + pct, ceil), source: "markup", ...(label ? { label } : {}), pct };
      const verdict = await validateSalePrice(price, ctx);
      if (!verdict.ok) return { name, ok: false, error: verdict.reason === "unsellable" ? "unsellable" : "below_floor" };
      await save(price);
      return { name, ok: true, price, belowFloor: false };
    }
    const price = { ...core, ...scale(base, 100 - pct, Math.round), source: "promo", ...(label ? { label } : {}), pct, endsAt, restore: prior ?? null };
    await save(price);
    return { name, ok: true, price, belowFloor: await belowFloor(price, ctx) };
  }
}
