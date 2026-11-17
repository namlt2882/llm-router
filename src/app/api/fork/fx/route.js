import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { clearPin, getFloorRate, getMarginPct, pinRate, refreshFxRates, setMarginPct } from "@/lib/fx/fxRate.js";

const NO_STORE = { "Cache-Control": "no-store" };
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
const bad = (error) => NextResponse.json({ error }, { status: 400, headers: NO_STORE });

async function current() {
  try {
    return { ...(await getFloorRate()), marginPct: await getMarginPct() };
  } catch {
    return null;
  }
}

export async function GET(request) {
  if (!(await assertForkAdmin(request))) return unauthorized();
  const state = await current();
  if (!state) return NextResponse.json({ error: "fx_rate_unavailable" }, { status: 503, headers: NO_STORE });
  return NextResponse.json(state, { headers: NO_STORE });
}

export async function PUT(request) {
  if (!(await assertForkAdmin(request))) return unauthorized();
  let body;
  try {
    body = await request.json();
  } catch {
    return bad("Invalid JSON body");
  }
  try {
    if (body?.pin === null) await clearPin();
    else if (body?.pin) await pinRate({ rate: body.pin.rate, expiresAt: body.pin.expiresAt });
    if (body?.marginPct !== undefined) await setMarginPct(body.marginPct);
  } catch (e) {
    return bad(e.message);
  }
  if (body?.refresh === true) await refreshFxRates();
  const state = await current();
  if (!state) return NextResponse.json({ error: "fx_rate_unavailable" }, { status: 503, headers: NO_STORE });
  return NextResponse.json(state, { headers: NO_STORE });
}
