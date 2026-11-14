import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { accountInflightLimit, getInflightSnapshot, getQueueStats } from "@/sse/services/accountInflight.js";
import { getSettings } from "@/lib/localDb";
import { setRuntimeLimits } from "@/sse/services/accountInflight.js";

export async function GET(request) {
  if (!(await assertForkAdmin(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const s = await getSettings();
  setRuntimeLimits({ accountMaxInflight: s.accountMaxInflight, upstreamWaitMs: s.upstreamWaitMs });
  const limit = accountInflightLimit();
  const { queued, oldestWaitMs, busy5m } = getQueueStats();
  return NextResponse.json(
    { accounts: getInflightSnapshot().map((a) => ({ ...a, limit })), queued, oldestWaitMs, busy5m },
    { headers: { "Cache-Control": "no-store" } },
  );
}
