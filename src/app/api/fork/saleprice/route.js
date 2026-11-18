import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { getSalePrice, listSalePrices, removeSalePrice, setSalePrice } from "@/lib/db/repos/salePriceRepo.js";
import { defaultContext, listFlagged, validateSalePrice } from "@/lib/pricing/validateSalePrice.js";
import { migrateLegacyPrices } from "@/lib/pricing/migrateLegacyPrices.js";

const TOKEN_KEYS = ["input", "output", "cached", "reasoning", "cacheCreation"];

// Only the fields the price list understands are stored; promotions are written by /api/fork/pricebulk, never here.
function sanitize(body) {
  const out = { name: body.name, kind: body.kind, unit: "usd" };
  for (const k of [...TOKEN_KEYS, "perImage"]) if (body[k] !== undefined) out[k] = body[k];
  if (body.source === "markup") {
    out.source = "markup";
    if (typeof body.pct === "number" && Number.isFinite(body.pct)) out.pct = body.pct;
    if (typeof body.label === "string" && body.label.length <= 200) out.label = body.label;
  }
  return out;
}

const NO_STORE = { "Cache-Control": "no-store" };
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

async function context() {
  try {
    return await defaultContext();
  } catch {
    return null;
  }
}
const noRate = () => NextResponse.json({ error: "fx_rate_unavailable" }, { status: 503, headers: NO_STORE });

export async function GET(request) {
  if (!(await assertForkAdmin(request))) return unauthorized();
  const name = new URL(request.url).searchParams.get("name");
  const ctx = await context();
  if (ctx) await migrateLegacyPrices({ rate: ctx.rate });
  if (name) return NextResponse.json({ price: await getSalePrice(name) }, { headers: NO_STORE });
  if (!ctx) return noRate();
  return NextResponse.json({ prices: await listSalePrices(), flagged: await listFlagged(ctx), rate: ctx.rate }, { headers: NO_STORE });
}

export async function PUT(request) {
  if (!(await assertForkAdmin(request))) return unauthorized();
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }
  if (body?.unit !== "usd") return NextResponse.json({ error: "unit_required" }, { status: 400, headers: NO_STORE });
  if (body.source !== undefined && body.source !== "markup") return NextResponse.json({ error: "invalid_source" }, { status: 400, headers: NO_STORE });
  const entry = sanitize(body);
  const ctx = await context();
  if (!ctx) return noRate();
  const v = await validateSalePrice(entry, ctx);
  if (!v.ok) {
    const { ok, ...rest } = v;
    return NextResponse.json({ error: v.minimum !== undefined ? "below_floor" : v.reason, ...rest }, { status: 422, headers: NO_STORE });
  }
  await setSalePrice(entry);
  return NextResponse.json({ price: entry }, { headers: NO_STORE });
}

export async function DELETE(request) {
  if (!(await assertForkAdmin(request))) return unauthorized();
  const name = new URL(request.url).searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400, headers: NO_STORE });
  await removeSalePrice(name);
  return NextResponse.json({ deleted: name }, { headers: NO_STORE });
}
