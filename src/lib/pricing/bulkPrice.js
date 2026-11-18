import { getSalePrice, setSalePrice, removeSalePrice } from "@/lib/db/repos/salePriceRepo.js";
import { costFloor, validateSalePrice } from "@/lib/pricing/validateSalePrice.js";
import { effectiveUsdPrice, resolveStored } from "@/lib/pricing/effectiveSalePrice.js";
import { FIELDS, TOKEN_FIELDS, ceil6, round6, toUsdRow } from "@/lib/pricing/priceUnit.js";
import { priceForPrompt, tierBreakpoints } from "../../../open-sse/utils/priceTiers.js";

/** True when any token field of a USD price sits under the USD cost floor; false when the name has no floor. */
export async function belowFloor(price, ctx) {
  const { floor, error } = await costFloor(price.name, price.kind, ctx);
  if (error) return false;
  // Price and floor are both piecewise constant in the prompt size: test the first token of every interval.
  return [0, ...tierBreakpoints(floor, price).map((b) => b + 1)].some((n) => {
    const p = priceForPrompt(price, n);
    const m = priceForPrompt(floor, n);
    return TOKEN_FIELDS.some((f) => p[f] < m[f]);
  });
}

const isActivePromo = (row, now) => !!row && row.source === "promo" && row.endsAt > now;

function scale(base, factor, round) {
  const out = {};
  for (const f of FIELDS) out[f] = round((Number(base[f] ?? 0) * factor) / 100);
  if (Array.isArray(base.tiers) && base.tiers.length) {
    out.tiers = base.tiers.map((t) => {
      const o = { above: t.above };
      for (const f of TOKEN_FIELDS) if (f in t) o[f] = round((Number(t[f]) * factor) / 100);
      return o;
    });
  }
  return out;
}

/**
 * Apply a markup, a timed promotion, or a revert to many names at once by writing stored prices.
 * One name failing never blocks the others; each reports its own result.
 */
export async function applyBulk(
  { action, names, pct, label, endsAt },
  { stored = getSalePrice, save = setSalePrice, drop = removeSalePrice, ctx, now = Date.now() } = {},
) {
  const results = [];
  // A legacy credit row (and its restore) is read as USD at the context rate before any math.
  const toUsd = (row) => {
    if (!row || row.unit === "usd") return row ?? null;
    if (!Number.isFinite(ctx.rate) || !(ctx.rate > 0)) throw new Error("no_rate");
    return toUsdRow(row, ctx.rate);
  };
  for (const name of [...new Set(names)]) {
    try {
      results.push(await applyOne(name));
    } catch (e) {
      results.push({ name, ok: false, error: e?.message || "failed" });
    }
  }
  return { results };

  async function applyOne(name) {
    const original = await stored(name);
    if (action === "revert") {
      const raw = original;
      const back = raw?.source === "promo" ? (raw.restore ?? null) : null;
      if (back) await save(back);
      else if (raw) await drop(name);
      return { name, ok: true };
    }
    const raw = toUsd(original);
    if (action === "markup" && isActivePromo(raw, now)) return { name, ok: false, error: "in_promotion" };

    const current = resolveStored(raw, now);
    const promoActive = action === "promo" && isActivePromo(raw, now);
    const prior = promoActive ? (raw.restore ?? null) : current;
    const base = prior ?? (await effectiveUsdPrice(name, { stored: async () => null, ctx, now, at: null }));
    if (!base) return { name, ok: false, error: "unsellable" };

    const core = { name, kind: base.kind, unit: "usd" };
    if (action === "markup") {
      const price = { ...core, ...scale(base, 100 + pct, ceil6), source: "markup", ...(label ? { label } : {}), pct };
      const verdict = await validateSalePrice(price, ctx);
      if (!verdict.ok) return { name, ok: false, error: verdict.minimum !== undefined ? "below_floor" : verdict.reason };
      await save(price);
      return { name, ok: true, price, belowFloor: false };
    }
    const price = { ...core, ...scale(base, 100 - pct, round6), source: "promo", ...(label ? { label } : {}), pct, endsAt, restore: prior ?? null };
    await save(price);
    return { name, ok: true, price, belowFloor: await belowFloor(price, ctx) };
  }
}
