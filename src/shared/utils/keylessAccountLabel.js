/**
 * The keyless (noAuth) lane logs the provider id as its connection id, so the
 * server has no connection row to name it and falls back to "Account <id>...".
 * Give that lane a readable name; a real connection name is never touched.
 * @param {{connectionId?: string, accountName?: string}} item
 * @param {Record<string, {noAuth?: boolean}>} freeProviders
 */
export function withKeylessAccountName(item, freeProviders) {
  const id = item?.connectionId;
  if (!id || !freeProviders?.[id]?.noAuth) return item;
  if (item.accountName && !item.accountName.startsWith("Account ")) return item;
  return { ...item, accountName: `${id} (miễn phí)` };
}
