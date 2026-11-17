import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { getUsageByHoldId } from "@/lib/db/repos/holdUsageRepo.js";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (status, error) => NextResponse.json({ error }, { status, headers: NO_STORE });

// Fork patch #28: what the router itself recorded for one WaveBot hold, so the
// reaper can settle a hold whose caller died before it could read the cost.
// 404 means "never seen" — the caller must not read that as a free call.
export async function GET(request, { params }) {
  if (!(await assertForkAdmin(request))) return fail(401, "Unauthorized");
  const { id } = await params;
  const usage = await getUsageByHoldId(id);
  if (!usage) return fail(404, "unknown_hold");
  return NextResponse.json({ holdId: id, costCredits: usage.costCredits, attempts: usage.attempts }, { headers: NO_STORE });
}
