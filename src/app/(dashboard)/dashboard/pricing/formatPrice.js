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
