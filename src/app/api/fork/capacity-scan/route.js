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

/** Depth guard for a combo that references itself (or a cycle of combos). */
const MAX_NESTED_DEPTH = 8;

/**
 * Capacity of a combo's leaf members: for every active connection of each
 * member's provider, the fanout budget that request would run at (manual
 * budget → percent×detected → global). In-flight slots are counted per
 * ACCOUNT (connection id, or provider id for a keyless lane), not per model,
 * so every account counts once, at the highest budget any member gives it —
 * summing per member would count one account once per model.
 *
 * A nested combo (a member with no `/` that names another combo) is expanded
 * into its own leaves and counted like any other member: its accounts are real
 * accounts the outer combo can spread over, so `wavebot = [glm, opencode-go]`
 * reports glm + opencode-go's models, not just glm.
 *
 * The MARGIN is always the displayed combo's own (`ctx`), never the nested
 * combo's — a nested combo contributes its RAW capacity. Ruling 2026-11-16
 * (Steve): `opencode-go = 30 @ 50%` inside `wavebot = 10 + 30 @ 80%` is
 * `(10 + 30) × 80% = 32`, NOT `(10 + 30×50%) × 80% = 20`. A nested margin
 * never compounds into the outer one, and a nested combo's manual budgets are
 * likewise not the outer combo's configuration.
 */
async function comboSummary(name, settings) {
  const globalLimit = accountInflightLimit();
  const detected = settings?.detectedBudgets && typeof settings.detectedBudgets === "object" ? settings.detectedBudgets : {};
  const connections = (await getProviderConnections({})).filter(isActiveConnection);
  const lanes = new Map();
  const lane = (id, limit) => lanes.set(id, Math.max(lanes.get(id) || 0, limit));
  const seen = new Set();
  let members = 0, nested = 0;

  // `ctx` is the DISPLAYED combo's strategy, threaded unchanged into every
  // level: a nested combo is expanded for its models, not for its config.
  // Returns whether this combo actually contributed (false for a combo that is
  // unknown, empty or already visited — a cycle adds no accounts).
  async function walk(comboName, ctx, depth) {
    if (depth > MAX_NESTED_DEPTH || seen.has(comboName)) return false;
    const combo = await getComboByName(comboName);
    if (!combo?.models?.length) return false;
    seen.add(comboName);

    let contributed = false;
    for (const member of combo.models) {
      if (!member.includes("/")) {
        if (await getComboByName(member)) {
          if (await walk(member, ctx, depth + 1)) {
            nested += 1;
            contributed = true;
          }
        }
        continue;
      }
      const idx = member.indexOf("/");
      // Members store whatever the operator picked — usually the UI alias
      // (`ocg/beam-free`), while a connection stores the canonical provider id
      // (`opencode-go`). Compare canonically on BOTH sides or a measured combo
      // reports sum 0 ("no parameters") while its models have budgets.
      const providerId = resolveProviderId(member.slice(0, idx));
      const model = member.slice(idx + 1);
      members += 1;
      let counted = 0;
      for (const c of connections) {
        if (resolveProviderId(c.provider) !== providerId) continue;
        lane(c.id, effectiveFanoutBudget(ctx, c.id, globalLimit, detected, model));
        counted += 1;
      }
      // A keyless provider with no connections is served by ONE shared lane
      // whose account id is the provider id (auth.js) — count that lane.
      if (!counted && FREE_PROVIDERS[providerId]?.noAuth) {
        lane(providerId, keylessLaneLimit(effectiveFanoutBudget(ctx, providerId, globalLimit, detected, model), settings));
      }
      contributed = true;
    }
    return contributed;
  }

  const root = await getComboByName(name);
  if (!root?.models?.length) return null;
  const entry = (settings?.comboStrategies || {})[name] || {};
  await walk(name, fanoutCtxForEntry(entry), 0);

  let sum = 0;
  for (const limit of lanes.values()) sum += limit;
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
