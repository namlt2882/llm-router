export const fmtUsd = (n) =>
  Number.isFinite(n) ? Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 }) : "-";

export const fmtVnd = (usd, rate) =>
  Number.isFinite(usd) && Number.isFinite(rate) ? Math.round(usd * rate).toLocaleString("en-US") : "-";

export const showPrice = (usd, mode, rate) => (mode === "vnd" ? fmtVnd(usd, rate) : fmtUsd(usd));

// A blank or non-numeric default-base field is an error, never a silent 0 (0 would sell that token type free).
export function parseDefaultBase({ enabled, input, cached, output }) {
  const body = { enabled: !!enabled };
  for (const [field, raw] of [["input", input], ["cached", cached], ["output", output]]) {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return { error: `${field} must be a number` };
    body[field] = n;
  }
  return { body };
}

export function fmtTokens(n) {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}K`;
  return String(n);
}

/** One "> 200K: input / cached / output" line per context tier of a price row, in the chosen unit. */
export const tierLines = (row, mode, rate) =>
  (row?.tiers ?? []).map((t) => `> ${fmtTokens(t.above)}: ${[t.input, t.cached, t.output].map((v) => showPrice(v, mode, rate)).join(" / ")}`);

const TIER_KEYS = ["input", "cached", "output", "reasoning", "cacheCreation"];

/** The tiers the edit form starts from: the live price's, else the cost floor's, with prices as strings for the inputs. */
export function editTiersFrom(effective, floor) {
  const source = effective?.tiers?.length ? effective.tiers : floor?.tiers ?? [];
  return source.map((t) => ({ above: t.above, ...Object.fromEntries(TIER_KEYS.filter((k) => t[k] !== undefined).map((k) => [k, String(t[k])])) }));
}

/** Edited tier strings back to numbers for the PUT body; undefined when there are none. */
export function tiersForSave(edit) {
  if (!edit?.length) return undefined;
  return edit.map((t) => ({ above: Number(t.above), ...Object.fromEntries(TIER_KEYS.filter((k) => t[k] !== undefined && t[k] !== "").map((k) => [k, Number(t[k])])) }));
}
