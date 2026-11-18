import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { settleExpired } from "@/lib/pricing/settleExpired.js";
import { defaultContext } from "@/lib/pricing/validateSalePrice.js";
import { listPrices } from "@/lib/pricing/priceList.js";
import { migrateLegacyPrices } from "@/lib/pricing/migrateLegacyPrices.js";
import { getPriceDefault } from "@/lib/db/repos/priceDefaultRepo.js";

const NO_STORE = { "Cache-Control": "no-store" };
const NAMES_TTL_MS = 60_000;
const fail = (status, error) => NextResponse.json({ error }, { status, headers: NO_STORE });

let namesCache = { at: 0, names: [] };
let refreshing = null;

function refreshNames() {
  if (!refreshing) {
    refreshing = buildModelsList(["llm"])
      .then((list) => {
        namesCache = { at: Date.now(), names: list.map((m) => m.id) };
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

// Provider model discovery can be slow, so a stale list is served at once and refreshed in the background.
// Only the very first call (nothing cached yet) waits.
async function servedNames(now) {
  if (namesCache.at === 0) {
    await refreshNames();
  } else if (now - namesCache.at >= NAMES_TTL_MS) {
    refreshNames().catch(() => {});
  }
  return namesCache.names;
}

// Fork patches #30/#31: every served model and combo with its USD floor, stored price, effective price and status.
export async function GET(request) {
  if (!(await assertForkAdmin(request))) return fail(401, "Unauthorized");
  let ctx;
  try {
    ctx = await defaultContext();
  } catch {
    return fail(503, "fx_rate_unavailable");
  }
  const now = Date.now();
  await migrateLegacyPrices({ rate: ctx.rate });
  await settleExpired({ now });
  const rows = await listPrices({ names: await servedNames(now), ctx, now });
  return NextResponse.json({ rows, rate: ctx.rate, default: await getPriceDefault() }, { headers: NO_STORE });
}
