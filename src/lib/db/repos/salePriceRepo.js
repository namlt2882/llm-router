import { makeKv } from "../helpers/kvStore.js";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

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

/** Read-modify-write one row inside a single transaction. `fn(current|null)` returns the row to store, or undefined to leave it. */
export async function updateSalePrice(name, fn) {
  const db = await getAdapter();
  return db.transaction(() => {
    const found = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, ["saleprice", name]);
    const next = fn(found ? parseJson(found.value, null) : null);
    if (next !== undefined) {
      db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, ["saleprice", name, stringifyJson(next)]);
    }
    return next;
  });
}
