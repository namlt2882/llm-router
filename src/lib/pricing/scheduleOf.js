import { hasSchedule } from "../../../open-sse/utils/priceSchedule.js";

/** The first price schedule found depth-first among the leaves of a model or combo; null when none (or on a cycle). */
export async function scheduleOf(name, ctx, seen = new Set()) {
  const members = await ctx.comboModels(name);
  if (!members) {
    const id = (await ctx.baseFor(name))?.offPeak?.schedule;
    return typeof id === "string" && hasSchedule(id) ? id : null;
  }
  if (seen.has(name)) return null;
  const next = new Set(seen).add(name);
  for (const m of members) {
    const id = await scheduleOf(m, ctx, next);
    if (id) return id;
  }
  return null;
}
