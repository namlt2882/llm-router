import { getFloorRate } from "@/lib/fx/fxRate.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { getComboByName } from "@/lib/db/repos/combosRepo.js";
import { listSalePrices } from "@/lib/db/repos/salePriceRepo.js";
import { getPriceDefault } from "@/lib/db/repos/priceDefaultRepo.js";
import { ceil6, toUsdRow, defaultBase, MAX_USD_PRICE, MAX_TIERS, TOKEN_FIELDS } from "@/lib/pricing/priceUnit.js";
import { priceForPrompt, tierBreakpoints, settleBand } from "../../../open-sse/utils/priceTiers.js";

// Sale field -> base field (base prices are USD per 1M tokens, snake_case).
const FIELDS = [
  ["input", "input"],
  ["output", "output"],
  ["cached", "cached"],
  ["reasoning", "reasoning"],
  ["cacheCreation", "cache_creation"],
];

const badTiers = { ok: false, field: "tiers", reason: "invalid" };
function validateTiers(tiers) {
  if (tiers === undefined) return null;
  if (!Array.isArray(tiers) || tiers.length > MAX_TIERS) return badTiers;
  const seen = new Set();
  for (const t of tiers) {
    if (!t || typeof t !== "object" || typeof t.above !== "number" || !Number.isFinite(t.above) || t.above <= 0 || seen.has(t.above)) return badTiers;
    seen.add(t.above);
    for (const f of TOKEN_FIELDS) {
      if (t[f] === undefined) continue;
      if (typeof t[f] !== "number" || !Number.isFinite(t[f]) || t[f] < 0) return badTiers;
      if (t[f] > MAX_USD_PRICE) return { ok: false, field: "tiers", reason: "too_high", maximum: MAX_USD_PRICE };
    }
  }
  return null;
}

const unsellable = (name) => ({ ok: false, field: "name", reason: "unsellable", name });

// A name's base as USD per 1M tokens: a model's own base, a combo's per-field average of its members
// (a nested combo is one member at its own average, a duplicated member counts each time).
// open-sse/providers/pricing.js charges a missing (or zero) cached / cache-write rate at input and reasoning at output.
const fallbacks = (b) => ({
  ...b,
  cached: b.cached || b.input,
  reasoning: b.reasoning || b.output,
  cache_creation: b.cache_creation || b.input,
});
// Every tier is read as the flat rate of a long prompt: it inherits what it leaves out from the base row, then the same fallbacks.
const withCostFallbacks = ({ tiers, ...flat }) => {
  const out = fallbacks(flat);
  if (Array.isArray(tiers) && tiers.length) out.tiers = tiers.map(({ above, ...rates }) => ({ above, ...fallbacks({ ...flat, ...rates }) }));
  return out;
};

async function unitBase(name, ctx, seen = new Set(), at) {
  const members = await ctx.comboModels(name);
  if (!members) {
    const b = await ctx.baseFor(name);
    return b ? { base: withCostFallbacks(settleBand(b, at)), defaulted: !!b.defaulted } : null;
  }
  if (seen.has(name)) return "cycle";
  const next = new Set(seen).add(name);
  const parts = [];
  for (const m of members) {
    const r = await unitBase(m, ctx, next, at);
    if (r === "cycle") return "cycle";
    if (!r) return null;
    parts.push(r);
  }
  const averageAt = (n) => {
    const out = {};
    for (const [, baseField] of FIELDS) {
      out[baseField] = parts.reduce((sum, p) => sum + Number(priceForPrompt(p.base, n)[baseField] ?? 0), 0) / parts.length;
    }
    return out;
  };
  const base = averageAt(0);
  // A combo is sold at the average of its members, and a member steps up where its own tiers do.
  const breaks = tierBreakpoints(...parts.map((p) => p.base));
  if (breaks.length) base.tiers = breaks.map((above) => ({ above, ...averageAt(above + 1) }));
  return { base, defaulted: parts.some((p) => p.defaulted) };
}

/**
 * Cost floor in USD per 1M tokens (no FX rate): the base, or a combo's average of its members, rounded up to 6 decimals.
 * Peak rates unless `at` (ms) is given: only the auto sale price asks for the band, validation and bulk edits never do.
 */
export async function costFloor(name, kind, ctx, { at } = {}) {
  if (kind === "combo" && !(await ctx.comboModels(name))) return { error: unsellable(name) };
  const r = await unitBase(name, ctx, new Set(), at);
  if (r === "cycle") return { error: { ok: false, field: "name", reason: "combo_cycle", name } };
  if (!r) return { error: unsellable(name) };
  const floor = {};
  for (const [field, baseField] of FIELDS) floor[field] = ceil6(Number(r.base[baseField] ?? 0));
  if (r.base.tiers?.length) {
    floor.tiers = r.base.tiers.map((t) => {
      const out = { above: t.above };
      for (const [field, baseField] of FIELDS) out[field] = ceil6(Number(t[baseField] ?? 0));
      return out;
    });
  }
  return { floor, defaulted: r.defaulted };
}

export async function validateSalePrice(entry, ctx) {
  if (!entry || typeof entry.name !== "string" || !entry.name) return { ok: false, field: "name", reason: "invalid" };
  if (entry.kind !== "model" && entry.kind !== "combo") return { ok: false, field: "kind", reason: "invalid" };
  const isCombo = !!(await ctx.comboModels(entry.name));
  if ((entry.kind === "combo") !== isCombo) return { ok: false, field: "kind", reason: "kind_mismatch" };
  for (const [field] of FIELDS) {
    const v = entry[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { ok: false, field, reason: "invalid" };
    if (v > MAX_USD_PRICE) return { ok: false, field, reason: "too_high", maximum: MAX_USD_PRICE };
  }
  if (entry.perImage !== undefined && !(typeof entry.perImage === "number" && Number.isFinite(entry.perImage) && entry.perImage >= 0)) {
    return { ok: false, field: "perImage", reason: "invalid" };
  }
  if (entry.perImage > MAX_USD_PRICE) return { ok: false, field: "perImage", reason: "too_high", maximum: MAX_USD_PRICE };
  const tiersBad = validateTiers(entry.tiers);
  if (tiersBad) return tiersBad;
  const { floor, error } = await costFloor(entry.name, entry.kind, ctx);
  if (error) return error;
  // A price is piecewise constant in the prompt size, so checking each interval's first token covers all of it.
  for (const n of [0, ...tierBreakpoints(floor, entry).map((b) => b + 1)]) {
    const sale = priceForPrompt(entry, n);
    const min = priceForPrompt(floor, n);
    for (const [field] of FIELDS) {
      // Exact compare: a price at the floor passes, one unit below fails.
      if (sale[field] < min[field]) return { ok: false, field, minimum: min[field] };
    }
  }
  return { ok: true };
}

/** Rows that fall below the floor after a base change (a legacy credit row is judged at the current rate). Never rewritten. A running promotion is under cost on purpose and is not a fault. */
export async function listFlagged(ctx) {
  const out = [];
  const now = ctx.now ?? Date.now();
  for (const row of await listSalePrices()) {
    if (row.source === "promo" && row.endsAt > now) continue;
    const violation = await validateSalePrice(toUsdRow(row, ctx.rate), ctx);
    if (!violation.ok) out.push({ ...row, violation });
  }
  return out;
}

// The default base is sale-side only: it is never visible to pricingRepo / usage cost.
export async function defaultContext(now = Date.now()) {
  const { rate } = await getFloorRate(now);
  const setting = await getPriceDefault();
  return {
    rate,
    baseFor: async (name) => {
      const i = name.indexOf("/");
      if (i < 0) return null;
      const real = await getPricingForModel(name.slice(0, i), name.slice(i + 1));
      if (real) return real;
      return setting.enabled ? { ...defaultBase(setting), defaulted: true } : null;
    },
    comboModels: async (name) => {
      if (name.includes("/")) return null;
      const c = await getComboByName(name);
      return c?.models?.length ? c.models : null;
    },
  };
}
