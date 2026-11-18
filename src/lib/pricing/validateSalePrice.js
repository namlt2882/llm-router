import { getFloorRate } from "@/lib/fx/fxRate.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { getComboByName } from "@/lib/db/repos/combosRepo.js";
import { listSalePrices } from "@/lib/db/repos/salePriceRepo.js";
import { getPriceDefault } from "@/lib/db/repos/priceDefaultRepo.js";
import { ceil6, toUsdRow, defaultBase } from "@/lib/pricing/priceUnit.js";

// Sale field -> base field (base prices are USD per 1M tokens, snake_case).
const FIELDS = [
  ["input", "input"],
  ["output", "output"],
  ["cached", "cached"],
  ["reasoning", "reasoning"],
  ["cacheCreation", "cache_creation"],
];

const unsellable = (name) => ({ ok: false, field: "name", reason: "unsellable", name });

// A name's base as USD per 1M tokens: a model's own base, a combo's per-field average of its members
// (a nested combo is one member at its own average, a duplicated member counts each time).
// open-sse/providers/pricing.js charges a missing (or zero) cached / cache-write rate at input and reasoning at output.
const withCostFallbacks = (b) => ({
  ...b,
  cached: b.cached || b.input,
  reasoning: b.reasoning || b.output,
  cache_creation: b.cache_creation || b.input,
});

async function unitBase(name, ctx, seen = new Set()) {
  const members = await ctx.comboModels(name);
  if (!members) {
    const b = await ctx.baseFor(name);
    return b ? { base: withCostFallbacks(b), defaulted: !!b.defaulted } : null;
  }
  if (seen.has(name)) return "cycle";
  const next = new Set(seen).add(name);
  const parts = [];
  for (const m of members) {
    const r = await unitBase(m, ctx, next);
    if (r === "cycle") return "cycle";
    if (!r) return null;
    parts.push(r);
  }
  const base = {};
  for (const [, baseField] of FIELDS) {
    base[baseField] = parts.reduce((sum, p) => sum + Number(p.base[baseField] ?? 0), 0) / parts.length;
  }
  return { base, defaulted: parts.some((p) => p.defaulted) };
}

/** Cost floor in USD per 1M tokens (no FX rate): the base, or a combo's average of its members, rounded up to 6 decimals. */
export async function costFloor(name, kind, ctx) {
  if (kind === "combo" && !(await ctx.comboModels(name))) return { error: unsellable(name) };
  const r = await unitBase(name, ctx);
  if (r === "cycle") return { error: { ok: false, field: "name", reason: "combo_cycle", name } };
  if (!r) return { error: unsellable(name) };
  const floor = {};
  for (const [field, baseField] of FIELDS) floor[field] = ceil6(Number(r.base[baseField] ?? 0));
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
  }
  if (entry.perImage !== undefined && !(typeof entry.perImage === "number" && Number.isFinite(entry.perImage) && entry.perImage >= 0)) {
    return { ok: false, field: "perImage", reason: "invalid" };
  }
  const { floor, error } = await costFloor(entry.name, entry.kind, ctx);
  if (error) return error;
  for (const [field] of FIELDS) {
    // Exact compare: a price at the floor passes, one unit below fails.
    if (entry[field] < floor[field]) return { ok: false, field, minimum: floor[field] };
  }
  return { ok: true };
}

/** Rows that fall below the floor after a base change (a legacy credit row is judged at the current rate). Never rewritten. */
export async function listFlagged(ctx) {
  const out = [];
  for (const row of await listSalePrices()) {
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
