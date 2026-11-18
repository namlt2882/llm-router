import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { effectiveSalePrice } from "@/lib/pricing/effectiveSalePrice.js";
import { getFloorRate } from "@/lib/fx/fxRate.js";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_COUNT = 1e12;
const fail = (status, error) => NextResponse.json({ error }, { status, headers: NO_STORE });

const count = (v, { required = false } = {}) => {
  if (v === undefined || v === null) return required ? null : 0;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT ? v : null;
};

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
  const sale = await effectiveSalePrice(body.model);
  if (!sale) return fail(402, "not_sellable");
  let rate;
  try {
    rate = (await getFloorRate()).rate;
  } catch {
    return fail(503, "fx_rate_unavailable");
  }
  const perMillion = inputTokens * sale.input + maxTokens * sale.output + reasoning * sale.reasoning;
  const creditsWorstCase = Math.ceil(perMillion / 1e6 - 1e-9) + images * (sale.perImage || 0);
  return NextResponse.json(
    {
      creditsWorstCase,
      sale: { input: sale.input, output: sale.output, cached: sale.cached, reasoning: sale.reasoning, cacheCreation: sale.cacheCreation, perImage: sale.perImage || 0, ...(sale.auto ? { auto: true } : {}) },
      floorRate: rate,
    },
    { headers: NO_STORE },
  );
}
