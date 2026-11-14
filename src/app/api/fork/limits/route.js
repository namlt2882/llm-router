import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { getSettings, updateSettings } from "@/lib/localDb";
import { accountInflightLimit, getUpstreamWaitMs, setRuntimeLimits } from "@/sse/services/accountInflight.js";

const NO_STORE = { "Cache-Control": "no-store" };
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

async function current() {
  const s = await getSettings();
  setRuntimeLimits({ accountMaxInflight: s.accountMaxInflight, upstreamWaitMs: s.upstreamWaitMs });
  return { account_max_inflight: accountInflightLimit(), upstream_wait_ms: getUpstreamWaitMs() };
}

export async function GET(request) {
  if (!(await assertForkAdmin(request))) return unauthorized();
  return NextResponse.json(await current(), { headers: NO_STORE });
}

function inRange(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

export async function PUT(request) {
  if (!(await assertForkAdmin(request))) return unauthorized();
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }
  if (!inRange(body?.account_max_inflight, 1, 64)) {
    return NextResponse.json({ error: "account_max_inflight must be an integer 1-64" }, { status: 400, headers: NO_STORE });
  }
  if (!inRange(body?.upstream_wait_ms, 0, 120000)) {
    return NextResponse.json({ error: "upstream_wait_ms must be an integer 0-120000" }, { status: 400, headers: NO_STORE });
  }
  await updateSettings({ accountMaxInflight: body.account_max_inflight, upstreamWaitMs: body.upstream_wait_ms });
  return NextResponse.json(await current(), { headers: NO_STORE });
}
