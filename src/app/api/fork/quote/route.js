import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { effectiveSalePrice, effectiveUsdPrice } from "@/lib/pricing/effectiveSalePrice.js";
import { defaultContext } from "@/lib/pricing/validateSalePrice.js";
import { belowFloor } from "@/lib/pricing/bulkPrice.js";
import { getFloorRate } from "@/lib/fx/fxRate.js";
import { getSalePrice } from "@/lib/db/repos/salePriceRepo.js";
import { resolveStored } from "@/lib/pricing/effectiveSalePrice.js";
import { priceForReserve } from "../../../../../open-sse/utils/priceTiers.js";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_COUNT = 1e12;
// A USD or auto price becomes credits at the floor rate, which refreshes every 6 h. A quote held across a refresh could
// be billed at a slightly higher rate and cut short, so such a quote reserves 1% extra. A legacy credit row does not float.
const FX_HEADROOM = 1.01;
const fail = (status, error) => NextResponse.json({ error }, { status, headers: NO_STORE });

const count = (v, { required = false } = {}) => {
  if (v === undefined || v === null) return required ? null : 0;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT ? v : null;
};

const storedIsUsd = async (name) => resolveStored(await getSalePrice(name), Date.now())?.unit === "usd";

// Fork patch #27: worst-case credits a call can cost, so WaveBot can hold them before the call.
export async function POST(request) {
  if (!(await assertForkAdmin(request))) return fail(401, "Unauthorized");
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }
  const inputTokens = count(body?.inputTokens, { required: true });
  const maxTokens = count(body?.maxTokens, { required: true });
  const reasoning = count(body?.reasoningAllowance);
  const images = count(body?.images);
  if (typeof body?.model !== "string" || !body.model || [inputTokens, maxTokens, reasoning, images].includes(null)) {
    return fail(400, "model, inputTokens and maxTokens are required non-negative numbers");
  }
  const sale = await effectiveSalePrice(body.model, { at: null });
  if (!sale) return fail(402, "not_sellable");
  let rate;
  try {
    rate = (await getFloorRate()).rate;
  } catch {
    return fail(503, "fx_rate_unavailable");
  }
  const promo = sale.source === "promo";
  const promoUnderFloor = promo ? await belowFloor(await effectiveUsdPrice(body.model, { at: null }), await defaultContext()).catch(() => false) : false;
  // A long prompt bills every token at its tier, so the worst case is priced at the dearer tier the input size or 1.25x it lands in (the caller only estimates).
  const at = priceForReserve(sale, inputTokens);
  const perMillion = inputTokens * at.input + maxTokens * at.output + reasoning * at.reasoning;
  const floats = sale.auto === true || (await storedIsUsd(body.model));
  const fxHeadroom = floats ? FX_HEADROOM : 1;
  const creditsWorstCase = Math.ceil((perMillion / 1e6) * fxHeadroom - 1e-9) + Math.ceil(images * (sale.perImage || 0) * fxHeadroom - 1e-9);
  return NextResponse.json(
    {
      creditsWorstCase,
      sale: { input: sale.input, output: sale.output, cached: sale.cached, reasoning: sale.reasoning, cacheCreation: sale.cacheCreation, perImage: sale.perImage || 0, ...(sale.tiers?.length ? { tiers: sale.tiers } : {}), ...(sale.auto ? { auto: true } : {}), ...(promo ? { endsAt: sale.endsAt, ...(promoUnderFloor ? { belowFloor: true } : {}) } : {}) },
      floorRate: rate,
      fxHeadroom,
    },
    { headers: NO_STORE },
  );
}
