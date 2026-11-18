import { makeKv } from "../helpers/kvStore.js";
import { DEFAULT_BASE_SETTING } from "@/lib/pricing/priceUnit.js";

const kv = makeKv("pricingdefault");
const KEY = "default";

export async function getPriceDefault() {
  return { ...DEFAULT_BASE_SETTING, ...(await kv.get(KEY, {})) };
}

export async function setPriceDefault(patch) {
  const next = { ...(await getPriceDefault()), ...patch };
  await kv.set(KEY, next);
  return next;
}
