const MATCH = {
  all: () => true,
  model: (r) => r.kind === "model",
  combo: (r) => r.kind === "combo",
  custom: (r) => r.status === "custom" || r.status === "markup",
  promo: (r) => r.status === "promo",
  below_floor: (r) => r.belowFloor === true,
};

export function filterRows(rows, { q = "", filter = "all" } = {}) {
  const needle = q.trim().toLowerCase();
  const match = MATCH[filter] || MATCH.all;
  return rows.filter((r) => match(r) && (!needle || r.name.toLowerCase().includes(needle)));
}
