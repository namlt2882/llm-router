import { getFloorRate } from "@/lib/fx/fxRate.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { getComboByName } from "@/lib/db/repos/combosRepo.js";
import { listSalePrices } from "@/lib/db/repos/salePriceRepo.js";

// Sale field -> base field (base prices are USD per 1M tokens, snake_case).
const FIELDS = [
  ["input", "input"],
  ["output", "output"],
  ["cached", "cached"],
  ["reasoning", "reasoning"],
  ["cacheCreation", "cache_creation"],
];

const unsellable = (name) => ({ ok: false, field: "name", reason: "unsellable", name });

async function leafBases(name, ctx, seen = new Set()) {
  const members = await ctx.comboModels(name);
  if (!members) {
    const b = await ctx.baseFor(name);
    return b ? [b] : null;
  }
  if (seen.has(name)) return "cycle";
  const next = new Set(seen).add(name);
  const out = [];
  for (const m of members) {
    const r = await leafBases(m, ctx, next);
    if (r === "cycle") return "cycle";
    if (!r) return null;
    out.push(...r);
  }
  return out;
}

/** Cost floor in credits: for each field the dearest leaf base × rate. */
export async function costFloor(name, kind, ctx) {
  let bases;
  if (kind === "combo") {
    if (!(await ctx.comboModels(name))) return { error: unsellable(name) };
    bases = await leafBases(name, ctx);
    if (bases === "cycle") return { error: { ok: false, field: "name", reason: "combo_cycle", name } };
  } else {
    const b = await ctx.baseFor(name);
    bases = b ? [b] : null;
  }
  if (!bases || bases.length === 0) return { error: unsellable(name) };
  const floor = {};
  for (const [field, baseField] of FIELDS) {
    floor[field] = Math.max(...bases.map((b) => Number(b[baseField] ?? 0))) * ctx.rate;
  }
  return { floor };
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

/** Rows that fall below the floor after a rate or base change. Never rewritten. */
export async function listFlagged(ctx) {
  const out = [];
  for (const row of await listSalePrices()) {
    const violation = await validateSalePrice(row, ctx);
    if (!violation.ok) out.push({ ...row, violation });
  }
  return out;
}

async function baseFor(name) {
  const i = name.indexOf("/");
  if (i < 0) return null;
  const p = await getPricingForModel(name.slice(0, i), name.slice(i + 1));
  return p ?? null;
}

export async function defaultContext(now = Date.now()) {
  const { rate } = await getFloorRate(now);
  return {
    rate,
    baseFor,
    comboModels: async (name) => {
      if (name.includes("/")) return null;
      const c = await getComboByName(name);
      return c?.models?.length ? c.models : null;
    },
  };
}
