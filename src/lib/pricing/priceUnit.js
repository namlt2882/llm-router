export const TOKEN_FIELDS = ["input", "output", "cached", "reasoning", "cacheCreation"];
/** At most this many context tiers per price row. */
export const MAX_TIERS = 8;
export const FIELDS = [...TOKEN_FIELDS, "perImage"];
export const DEFAULT_BASE_SETTING = { enabled: false, input: 0.05, cached: 0.005, output: 0.1 };

/** Highest USD price per 1M tokens (or per image) that may be stored; above it the number is almost certainly a credit amount. */
export const MAX_USD_PRICE = 1_000_000;

const NOISE = 1e-12;

// Round up to 6 decimals; the relative guard keeps float noise (0.30000000000000004) from adding a micro-unit.
export const ceil6 = (x) => Math.ceil(x * 1e6 * (1 - NOISE)) / 1e6;
export const round6 = (x) => Math.round(x * 1e6) / 1e6;

// A tier keeps its `above` threshold (a token count) and converts every price field.
const mapTier = (t, fn) => {
  const out = { above: t.above };
  for (const f of TOKEN_FIELDS) if (f in t) out[f] = fn(t[f]);
  return out;
};

/** A stored row as USD per 1M tokens. A row without `unit: "usd"` is a legacy credit row and is converted at `rate`. */
export function toUsdRow(row, rate) {
  if (!row) return null;
  if (row.unit === "usd") return row;
  const out = { ...row, unit: "usd" };
  for (const f of FIELDS) if (f in row) out[f] = ceil6(Number(row[f]) / rate);
  if (Array.isArray(row.tiers)) out.tiers = row.tiers.map((t) => mapTier(t, (v) => ceil6(Number(v) / rate)));
  if ("restore" in row) out.restore = toUsdRow(row.restore, rate);
  return out;
}

/** The credit-shaped row the billing path reads (1 credit = 1 VND), derived from a USD row. */
export function toCredits(usdRow, rate) {
  const { unit, restore, ...rest } = usdRow;
  const out = { ...rest };
  for (const f of FIELDS) if (f in usdRow) out[f] = round6(Number(usdRow[f]) * rate);
  if (Array.isArray(usdRow.tiers)) out.tiers = usdRow.tiers.map((t) => mapTier(t, (v) => round6(Number(v) * rate)));
  return out;
}

/** The default base setting as a provider-style base (snake_case); reasoning follows output, cache write follows input. */
export function defaultBase({ input, cached, output }) {
  return { input, output, cached, reasoning: output, cache_creation: input };
}
