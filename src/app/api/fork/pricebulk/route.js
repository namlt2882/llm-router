import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { applyBulk } from "@/lib/pricing/bulkPrice.js";
import { defaultContext } from "@/lib/pricing/validateSalePrice.js";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_NAMES = 500;
const fail = (status, error) => NextResponse.json({ error }, { status, headers: NO_STORE });

// Fork patch #30: apply a markup, a timed promotion, or a revert to many names by writing stored prices.
export async function POST(request) {
  if (!(await assertForkAdmin(request))) return fail(401, "Unauthorized");
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }
  const { action, names, pct, label, endsAt } = body ?? {};
  if (!["markup", "promo", "revert"].includes(action)) return fail(400, "action must be markup, promo or revert");
  if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== "string" || !n)) {
    return fail(400, "names must be a non-empty array of model or combo names");
  }
  const unique = [...new Set(names)];
  if (unique.length > MAX_NAMES) return fail(400, `at most ${MAX_NAMES} names per call`);
  if (action !== "revert") {
    const max = action === "markup" ? 500 : 100;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0 || pct > max) return fail(400, `pct must be above 0 and at most ${max}`);
  }
  if (action === "promo" && !(typeof endsAt === "number" && Number.isFinite(endsAt) && endsAt > Date.now())) {
    return fail(400, "endsAt must be a future epoch-ms timestamp");
  }
  if (label !== undefined && (typeof label !== "string" || label.length > 200)) return fail(400, "label must be a string up to 200 characters");

  let ctx;
  try {
    ctx = await defaultContext();
  } catch {
    return fail(503, "fx_rate_unavailable");
  }
  const { results } = await applyBulk({ action, names: unique, pct, label, endsAt }, { ctx });
  return NextResponse.json({ results }, { headers: NO_STORE });
}
