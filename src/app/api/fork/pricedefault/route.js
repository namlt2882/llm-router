import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { getPriceDefault, setPriceDefault } from "@/lib/db/repos/priceDefaultRepo.js";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_USD = 1e6;
const fail = (status, error) => NextResponse.json({ error }, { status, headers: NO_STORE });

// Fork patch #31: the default base price (USD per 1M tokens) sold for names that have no base pricing.
export async function GET(request) {
  if (!(await assertForkAdmin(request))) return fail(401, "Unauthorized");
  return NextResponse.json({ default: await getPriceDefault() }, { headers: NO_STORE });
}

export async function PUT(request) {
  if (!(await assertForkAdmin(request))) return fail(401, "Unauthorized");
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "body must be an object");
  const patch = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return fail(400, "enabled must be a boolean");
    patch.enabled = body.enabled;
  }
  for (const field of ["input", "cached", "output"]) {
    if (body[field] === undefined) continue;
    const v = body[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_USD) return fail(400, `${field} must be a number from 0 to ${MAX_USD}`);
    patch[field] = v;
  }
  return NextResponse.json({ default: await setPriceDefault(patch) }, { headers: NO_STORE });
}
