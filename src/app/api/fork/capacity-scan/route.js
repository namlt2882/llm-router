import { NextResponse } from "next/server";
import { assertForkAdmin } from "@/lib/forkAdminAuth";
import { getSettings, getProviderConnections, getComboByName } from "@/lib/localDb";
import { accountInflightLimit } from "@/sse/services/accountInflight.js";
import { runCapacityScan } from "@/lib/fork/capacity/scan.js";
import { fanoutCtxForEntry, effectiveFanoutBudget, keylessLaneLimit } from "@/sse/services/fanoutBudget.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";

const NO_STORE = { "Cache-Control": "no-store" };
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

const isActiveConnection = (c) => c.isActive === true || c.isactive === "1";

/**
 * Σ capacity over a combo's leaf members: for every active connection of each
 * member's provider, the fanout budget that request would run at (manual
 * budget → percent×detected → global). Nested combos are counted, not summed
 * (their capacity is the max of their legs, and probing inside a combo is v2).
 */
async function comboSummary(name, settings) {
  const combo = await getComboByName(name);
  if (!combo?.models?.length) return null;
  const globalLimit = accountInflightLimit();
  const detected = settings?.detectedBudgets && typeof settings.detectedBudgets === "object" ? settings.detectedBudgets : {};
  const entry = (settings?.comboStrategies || {})[name] || {};
  const ctx = fanoutCtxForEntry(entry);
  const connections = (await getProviderConnections({})).filter(isActiveConnection);

  let sum = 0, members = 0, nested = 0;
  for (const member of combo.models) {
    if (!member.includes("/")) {
      if (await getComboByName(member)) nested += 1;
      continue;
    }
    const idx = member.indexOf("/");
    const provider = member.slice(0, idx);
    const model = member.slice(idx + 1);
    members += 1;
    let counted = 0;
    for (const c of connections) {
      if (c.provider !== provider) continue;
      sum += effectiveFanoutBudget(ctx, c.id, globalLimit, detected, model);
      counted += 1;
    }
    // A keyless provider with no connections is served by ONE shared lane whose
    // account id is the provider id (auth.js) — count that lane.
    const providerId = resolveProviderId(provider);
    if (!counted && FREE_PROVIDERS[providerId]?.noAuth) {
      sum += keylessLaneLimit(effectiveFanoutBudget(ctx, providerId, globalLimit, detected, model), settings);
    }
  }
  return { combo: name, sum, members, ...(nested ? { nested } : {}) };
}

export async function GET(request) {
  if (!(await assertForkAdmin(request))) return unauthorized();
  const settings = await getSettings();
  const state = settings?.capacityScan && typeof settings.capacityScan === "object" ? settings.capacityScan : {};
  const diagnosticModels = settings?.diagnosticModels && typeof settings.diagnosticModels === "object" ? settings.diagnosticModels : {};

  const body = {
    running: state.running === true,
    enabled: state.enabled === true,
    intervalHours: Number.isFinite(Number(state.intervalHours)) && Number(state.intervalHours) > 0 ? Number(state.intervalHours) : 24,
    lastRunAt: state.lastRunAt || null,
    nextRunAt: state.nextRunAt || null,
    lastResult: state.lastResult || null,
  };

  // coverage: how many diagnostic-model keys target a connection vs a provider
  const connections = await getProviderConnections({});
  const ids = new Set(connections.map((c) => c.id));
  let connectionsConfigured = 0, providersConfigured = 0;
  for (const key of Object.keys(diagnosticModels)) {
    if (ids.has(key)) connectionsConfigured += 1;
    else providersConfigured += 1;
  }
  body.coverage = { providersConfigured, connectionsConfigured };

  const comboName = new URL(request.url).searchParams.get("combo");
  if (comboName) {
    body.summary = await comboSummary(comboName, settings);
    if (!body.summary) return NextResponse.json({ error: `Unknown combo: ${comboName}` }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json(body, { headers: NO_STORE });
}

export async function POST(request) {
  if (!(await assertForkAdmin(request))) return unauthorized();
  const settings = await getSettings();
  if (settings?.capacityScan?.running === true) {
    return NextResponse.json({ started: false, running: true }, { status: 409, headers: NO_STORE });
  }
  // Optional { provider } — the provider card's own "Chạy chuẩn đoán" runs a
  // scoped diagnostic (only that provider's connections, daily schedule kept).
  let provider = null;
  try {
    const body = await request.json();
    if (typeof body?.provider === "string" && body.provider) provider = body.provider;
  } catch {
    // bodyless POST = the full system scan
  }
  // Fire-and-forget: the scan itself persists its running flag before the
  // first probe, so a follow-up GET/POST observes it immediately.
  runCapacityScan({ provider }).catch((e) => console.warn("[CAPACITY] scan failed:", e?.message || e));
  return NextResponse.json({ started: true, ...(provider ? { provider } : {}) }, { headers: NO_STORE });
}
