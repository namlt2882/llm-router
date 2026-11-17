/**
 * Quota re-check scheduler (Part 1 of the 2026-11-16 concurrency design).
 *
 * The live collapse (src/sse/services/quotaCollapse.js) schedules entries in
 * `settings.quotaRecheck` when a quota error states a reset within 24h. This
 * module ticks every 60s, probes each due lane with ONE tiny real request
 * (probeConnectionModel, maxLevel 1 — the upstream's verdict, not a guess),
 * and reopens the lane on success: previousBudget restored (or the
 * detectedBudgets key deleted) plus clearAccountError, the inverse of the
 * lock markAccountUnavailable set. The scan itself clears nothing, so this
 * is the only path that undoes a live collapse before tomorrow's scan.
 *
 * Outcome mapping:
 *   ok                     → restore + clear + drop the entry
 *   quota                  → fresh reset within horizon → reschedule; else drop
 *                            (rescheduling caps at 8 consecutive verdicts —
 *                            a rolling-window quota that never truly resets
 *                            must not reschedule forever)
 *   unreachable|unknown|throttle → keep the entry, retry next tick
 *   auth|config|balance|unsupported → terminal for this key → drop
 * A stale entry (>24h past its time) and an entry whose connection vanished
 * (and is not a keyless lane) drop without probing.
 */

import { getSettings, updateSettings, getProviderConnections } from "@/lib/localDb";
import { probeConnectionModel, dispatchFor } from "./probe.js";
import { clearAccountError } from "@/sse/services/auth.js";
import { FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { parseResetsIn, withQuotaSettingsLock } from "@/sse/services/quotaCollapse.js";

const DEFAULT_MAX_PER_TICK = 5;
const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;
const TRANSIENT = new Set(["unreachable", "unknown", "throttle"]);
const TERMINAL = new Set(["auth", "config", "balance", "unsupported"]);
// A rolling-window quota whose stated resets are always short reschedules
// this lane forever — `at` keeps moving, so the 24h staleness guard never
// fires. Eight consecutive quota-verdict reschedules with no restore between
// them hand the lane back to the daily scan (review minor M5).
const MAX_CONSECUTIVE_RESCHEDULES = 8;

const isKeylessLaneId = (id) => id === "noauth" || FREE_PROVIDERS[id]?.noAuth === true;

/**
 * @param {{
 *   now?: number,
 *   probeFn?: (input: { provider: string, connection: object, model: string, maxLevel: number }) => Promise<object>,
 *   getSettingsFn?: () => Promise<object>,
 *   updateSettingsFn?: (patch: object) => Promise<void>,
 *   clearAccountErrorFn?: (...args: unknown[]) => Promise<void>,
 *   getConnectionsFn?: () => Promise<object[]>,
 *   maxPerTick?: number,
 *   horizonMs?: number,
 * }} [deps]
 * @returns {Promise<{ probed: number, restored: number, rescheduled: number, dropped: number }>}
 */
export function processDueQuotaRecheck(deps = {}) {
  // Under the same lock as the live collapse: both are read-modify-write
  // over detectedBudgets/quotaRecheck, and a recheck tick interleaved with a
  // collapsing request would otherwise replace the collapse's whole map with
  // one computed from an older snapshot (see withQuotaSettingsLock).
  return withQuotaSettingsLock(() => processDueQuotaRecheckInner(deps));
}

async function processDueQuotaRecheckInner(deps = {}) {
  const {
    now = Date.now(),
    // Same default as the scan's probe: dispatchFor(provider, connection),
    // NOT the bare call (which would fall back to makeDefaultDispatch()).
    // Executor-backed providers — opencode free (TLS-ClientHello + forced
    // streaming) and opencode-go (400 MissingSessionID on a session-less
    // request) — are the GoUsageLimitError lanes this feature exists for,
    // and the generic openai POST can never reach them; custom nodes
    // (openai-compatible-*) are the opposite: no registry entry, no
    // executor, probeable only through the connection's own baseUrl.
    probeFn = ({ provider, connection, ...rest }) =>
      probeConnectionModel({ provider, connection, ...rest, dispatch: dispatchFor(provider, connection) }),
    getSettingsFn = getSettings,
    updateSettingsFn = updateSettings,
    clearAccountErrorFn = clearAccountError,
    getConnectionsFn = () => getProviderConnections({}),
    maxPerTick = DEFAULT_MAX_PER_TICK,
    horizonMs = DEFAULT_HORIZON_MS,
  } = deps;

  const settings = await getSettingsFn();
  const queue = Array.isArray(settings?.quotaRecheck) ? settings.quotaRecheck : [];
  if (!queue.length) return { probed: 0, restored: 0, rescheduled: 0, dropped: 0 };

  const connections = await getConnectionsFn();
  const byId = new Map(connections.map((c) => [c.id, c]));
  const out = { probed: 0, restored: 0, rescheduled: 0, dropped: 0 };
  const kept = [];
  // Restores of one tick accumulate into ONE map built from the snapshot
  // read above, so two entries for the same lane in a single tick cannot
  // clobber each other — and the final write below is the only thing that
  // persists them: getSettings returns a fresh object every call, so an
  // in-place mutation of it (the original implementation) never reached the
  // store and the lane stayed closed until the daily scan.
  let restoredBudgets = null;

  // Oldest first, capped: a burst of due entries probes at most maxPerTick
  // per tick so a mass collapse cannot become a mass probe burst.
  const due = queue
    .filter((entry) => entry && typeof entry.at === "string" && new Date(entry.at).getTime() <= now)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const tick = new Set(due);
  for (const entry of queue) {
    if (!tick.has(entry)) { kept.push(entry); continue; }
    const at = new Date(entry.at).getTime();
    const laneId = entry.connectionId;
    if (now - at > horizonMs || (!byId.has(laneId) && !isKeylessLaneId(laneId))) {
      out.dropped += 1;
      continue;
    }
    if (out.probed >= maxPerTick) { kept.push(entry); continue; }
    const connection = byId.get(laneId) || { id: laneId, provider: entry.provider || laneId, isActive: true };
    out.probed += 1;
    let verdict;
    try {
      verdict = await probeFn({ provider: entry.provider || connection.provider, connection, model: entry.model, maxLevel: 1 });
    } catch {
      verdict = { status: "unreachable" };
    }
    const status = verdict?.status;

    if (status === "ok") {
      restoredBudgets = restoredBudgets || (settings?.detectedBudgets && typeof settings.detectedBudgets === "object"
        ? { ...settings.detectedBudgets } : {});
      const lane = restoredBudgets[laneId] && typeof restoredBudgets[laneId] === "object"
        ? { ...restoredBudgets[laneId] } : {};
      const existing = lane[entry.model];
      if (existing && Number.isFinite(Number(existing.previousBudget))) {
        lane[entry.model] = { budget: Number(existing.previousBudget), detectedAt: existing.detectedAt };
      } else {
        delete lane[entry.model];
      }
      restoredBudgets[laneId] = lane; // lane may be empty — the connection key itself stays
      try {
        await clearAccountErrorFn(laneId, connection, entry.model);
      } catch (e) {
        console.warn("[QUOTA-RECHECK] clearAccountError failed:", e?.message || e);
      }
      out.restored += 1;
      continue; // entry dropped by not being kept
    }

    if (status === "quota") {
      const duration = parseResetsIn(verdict?.reason);
      const reschedules = Number.isFinite(Number(entry.reschedules)) ? Number(entry.reschedules) : 0;
      if (duration && duration <= horizonMs && reschedules < MAX_CONSECUTIVE_RESCHEDULES) {
        kept.push({ ...entry, at: new Date(now + duration).toISOString(), reschedules: reschedules + 1 });
        out.rescheduled += 1;
      } else {
        out.dropped += 1;
      }
      continue;
    }

    if (TRANSIENT.has(status)) { kept.push(entry); continue; }
    // TERMINAL verdicts — and anything unmapped — drop; the daily scan
    // remains the fallback for lanes this probe cannot decide.
    out.dropped += 1;
  }

  // One write per tick, and the restored budgets ride the SAME patch: they
  // must persist through updateSettings or the lane never reopens (C1).
  // Nothing due and nothing restored means the queue is byte-identical —
  // rewriting it every 60s would churn the settings row ~1,380× per 23h
  // pending entry (review minor M4). kept preserves queue order, so a
  // string compare is an exact deep-equality here.
  if (!restoredBudgets && JSON.stringify(kept) === JSON.stringify(queue)) return out;
  await updateSettingsFn({
    quotaRecheck: kept,
    ...(restoredBudgets ? { detectedBudgets: restoredBudgets } : {}),
  });
  return out;
}

let schedulerHandle = null;

/**
 * Start the re-check scheduler (one 60s interval per process, unref()d).
 * Idempotent: later calls return the existing handle. Same shape as
 * ensureCapacityScheduler.
 * @param {Parameters<processDueQuotaRecheck>[0]} [deps]
 * @returns {{ stop: () => void }}
 */
export function ensureQuotaRecheckScheduler(deps) {
  if (schedulerHandle) return schedulerHandle;
  const timer = setInterval(() => { processDueQuotaRecheck(deps).catch(() => {}); }, 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  schedulerHandle = { stop: () => { clearInterval(timer); schedulerHandle = null; } };
  return schedulerHandle;
}

/** Test-only: drop the module-level handle so a fresh test gets its own. */
export function resetQuotaRecheckScheduler() {
  schedulerHandle?.stop();
}
