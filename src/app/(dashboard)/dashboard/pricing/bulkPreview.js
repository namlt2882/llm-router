import { TOKEN_FIELDS, ceil6, round6 } from "@/lib/pricing/priceUnit.js";

/**
 * What a bulk action would do to one row, mirroring the server: markup rounds up and is refused on an active
 * promotion; a promotion rounds to 6 decimals and may end under cost. `to` is the input price, `under` covers every token field.
 */
export function bulkPreview(row, action, pct) {
  if (!Number.isFinite(pct) || pct <= 0) return null;
  const promo = row.status === "promo";
  const base = promo ? (row.stored?.restore ?? row.floor) : row.effective;
  if (!base) return null;
  const skip = action === "markup" && promo ? "in_promotion" : null;
  const next = {};
  for (const f of TOKEN_FIELDS) {
    const v = Number(base[f] ?? 0);
    next[f] = action === "markup" ? ceil6((v * (100 + pct)) / 100) : round6((v * (100 - pct)) / 100);
  }
  const under = row.floor ? TOKEN_FIELDS.some((f) => next[f] < Number(row.floor[f] ?? 0)) : false;
  return { from: row.effective?.input, to: next.input, under, skip };
}

/** The rows a bulk action acts on: selected, sellable, and still visible under the current search and filter. */
export const selectedVisible = (visible, selected) => visible.filter((r) => selected.has(r.name) && r.status !== "no_base_price");
