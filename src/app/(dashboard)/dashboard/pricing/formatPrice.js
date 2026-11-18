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

/** "in / cached / out" of a price row in the chosen unit; "-" when there is no price. */
export const priceCell = (row, mode, rate) =>
  row ? [row.input, row.cached, row.output].map((v) => showPrice(v, mode, rate)).join(" / ") : "-";

/** The two sale-price columns of a row: the standard (peak) price and the off-peak one, null where there is none. */
export function bandPrices(row) {
  if (row?.bands) return { standard: row.bands.peak ?? null, offpeak: row.bands.offpeak ?? null };
  return { standard: row?.effective ?? null, offpeak: null };
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

const utcMinute = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** "Peak now · off-peak from <UTC time>" for a price-list row's schedule; no change time when none is known. */
export function scheduleLabel(schedule) {
  const peak = schedule?.band !== "offpeak";
  const now = peak ? "Peak now" : "Off-peak now";
  if (schedule?.nextChangeAt == null) return now;
  return `${now} · ${peak ? "off-peak" : "peak"} from ${utcMinute(schedule.nextChangeAt)}`;
}

export const calendarStaleNotice = (rows) =>
  (rows ?? []).some((r) => r.schedule?.calendarStale)
    ? "Chinese holiday calendar is ending: add the next year's dates in open-sse/utils/priceSchedule.js"
    : null;
