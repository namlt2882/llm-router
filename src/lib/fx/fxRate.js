import { makeKv } from "@/lib/db/helpers/kvStore.js";

const kv = makeKv("fxrate");

const HOUR = 3600 * 1000;
export const REFRESH_INTERVAL_MS = 6 * HOUR;
export const STALE_AFTER_MS = 72 * HOUR;
export const DEFAULT_MARGIN_PCT = 0.02;
const MIN_RATE = 5000;
const MAX_RATE = 100000;

const plausible = (n) => typeof n === "number" && Number.isFinite(n) && n >= MIN_RATE && n <= MAX_RATE;

// A parser returns a plausible VND-per-USD number or throws; any shape change
// therefore reads as that source failing, never as a wrong rate.
const SOURCES = [
  {
    id: "open.er-api.com",
    url: "https://open.er-api.com/v6/latest/USD",
    parse: async (res) => {
      const j = await res.json();
      if (j?.result !== "success") throw new Error("er-api: not success");
      return j.rates?.VND;
    },
  },
  {
    id: "currency-api",
    url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    parse: async (res) => (await res.json())?.usd?.vnd,
  },
  {
    id: "vietcombank",
    url: "https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx",
    parse: async (res) => {
      const m = (await res.text()).match(/<Exrate\b[^>]*CurrencyCode="USD"[^>]*\bSell="([\d.,]+)"/);
      return m ? Number(m[1].replace(/,/g, "")) : NaN;
    },
  },
];

export async function refreshFxRates({ fetchImpl = fetch, now = Date.now() } = {}) {
  await Promise.all(
    SOURCES.map(async (src) => {
      try {
        const res = await fetchImpl(src.url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rate = await src.parse(res);
        if (!plausible(rate)) throw new Error("implausible rate");
        await kv.set(`source:${src.id}`, { rate, source: src.id, fetchedAt: now });
      } catch {
        // keep the last known value for this source
      }
    })
  );
  await kv.set("meta", { lastRefreshAt: now });
}

export async function maybeRefreshFxRates({ fetchImpl, now = Date.now() } = {}) {
  const meta = await kv.get("meta", null);
  if (meta?.lastRefreshAt && now - meta.lastRefreshAt < REFRESH_INTERVAL_MS) return false;
  await refreshFxRates({ fetchImpl, now });
  return true;
}

export async function getMarginPct() {
  const v = await kv.get("margin", null);
  return typeof v === "number" && v >= 0 && v <= 0.5 ? v : DEFAULT_MARGIN_PCT;
}

export async function setMarginPct(pct) {
  if (typeof pct !== "number" || !(pct >= 0 && pct <= 0.5)) throw new Error("marginPct must be between 0 and 0.5");
  await kv.set("margin", pct);
}

export async function pinRate({ rate, expiresAt }) {
  if (!plausible(rate)) throw new Error("rate must be a plausible VND-per-USD number");
  if (!Number.isFinite(expiresAt)) throw new Error("expiresAt must be epoch ms");
  await kv.set("pin", { rate, expiresAt });
}

export async function clearPin() {
  await kv.remove("pin");
}

export async function getFloorRate(now = Date.now()) {
  const pin = await kv.get("pin", null);
  if (pin && plausible(pin.rate) && pin.expiresAt > now) {
    return { rate: pin.rate, stale: false, source: "pin", pinned: true };
  }
  const all = await kv.getAll();
  const rows = Object.entries(all)
    .filter(([k, v]) => k.startsWith("source:") && plausible(v?.rate))
    .map(([, v]) => v);
  if (rows.length === 0) throw new Error("fx_rate_unavailable");
  const fresh = rows.filter((r) => now - r.fetchedAt <= STALE_AFTER_MS);
  const pool = fresh.length ? fresh : rows;
  const best = pool.reduce((a, b) => (b.rate > a.rate ? b : a));
  const margin = await getMarginPct();
  return { rate: best.rate * (1 + margin), stale: fresh.length === 0, source: best.source, pinned: false };
}

let loop = null;
export function startFxRefreshLoop() {
  if (loop) return;
  const tick = () => maybeRefreshFxRates().catch(() => {});
  tick();
  loop = setInterval(tick, REFRESH_INTERVAL_MS);
  loop.unref?.();
}
