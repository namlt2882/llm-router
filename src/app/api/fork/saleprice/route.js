import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { getSalePrice, listSalePrices, removeSalePrice, setSalePrice } from "@/lib/db/repos/salePriceRepo.js";
import { defaultContext, listFlagged, validateSalePrice } from "@/lib/pricing/validateSalePrice.js";

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
  if (name) return NextResponse.json({ price: await getSalePrice(name) }, { headers: NO_STORE });
  const ctx = await context();
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
  const ctx = await context();
  if (!ctx) return noRate();
  const v = await validateSalePrice(body, ctx);
  if (!v.ok) {
    const { ok, ...rest } = v;
    return NextResponse.json({ error: v.minimum !== undefined ? "below_floor" : v.reason, ...rest }, { status: 422, headers: NO_STORE });
  }
  await setSalePrice(body);
  return NextResponse.json({ price: body }, { headers: NO_STORE });
}

export async function DELETE(request) {
  if (!(await assertForkAdmin(request))) return unauthorized();
  const name = new URL(request.url).searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400, headers: NO_STORE });
  await removeSalePrice(name);
  return NextResponse.json({ deleted: name }, { headers: NO_STORE });
}
