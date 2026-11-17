import { makeKv } from "../helpers/kvStore.js";

const kv = makeKv("saleprice");

export async function getSalePrice(name) {
  return await kv.get(name, null);
}

export async function listSalePrices() {
  return Object.values(await kv.getAll());
}

export async function setSalePrice(entry) {
  await kv.set(entry.name, entry);
  return entry;
}

export async function removeSalePrice(name) {
  await kv.remove(name);
}
