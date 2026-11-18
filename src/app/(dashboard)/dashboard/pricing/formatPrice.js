export const fmtUsd = (n) =>
  Number.isFinite(n) ? Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 }) : "-";

export const fmtVnd = (usd, rate) =>
  Number.isFinite(usd) && Number.isFinite(rate) ? Math.round(usd * rate).toLocaleString("en-US") : "-";

export const showPrice = (usd, mode, rate) => (mode === "vnd" ? fmtVnd(usd, rate) : fmtUsd(usd));
