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
 *   unreachable|unknown|throttle → keep the entry, retry next tick
 *   auth|config|balance|unsupported → terminal for this key → drop
 * A stale entry (>24h past its time) and an entry whose connection vanished
 * (and is not a keyless lane) drop without probing.
 */

import { getSettings, updateSettings, getProviderConnections } from "@/lib/localDb";
import { probeConnectionModel } from "./probe.js";
import { clearAccountError } from "@/sse/services/auth.js";
import { FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { parseResetsIn } from "@/sse/services/quotaCollapse.js";

const DEFAULT_MAX_PER_TICK = 5;
const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;
const TRANSIENT = new Set(["unreachable", "unknown", "throttle"]);
const TERMINAL = new Set(["auth", "config", "balance", "unsupported"]);

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
export async function processDueQuotaRecheck(deps = {}) {
  const {
    now = Date.now(),
    probeFn = (input) => probeConnectionModel(input),
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
      const detectedBudgets = settings?.detectedBudgets && typeof settings.detectedBudgets === "object"
        ? { ...settings.detectedBudgets } : {};
      const lane = detectedBudgets[laneId] && typeof detectedBudgets[laneId] === "object"
        ? { ...detectedBudgets[laneId] } : {};
      const existing = lane[entry.model];
      if (existing && Number.isFinite(Number(existing.previousBudget))) {
        lane[entry.model] = { budget: Number(existing.previousBudget), detectedAt: existing.detectedAt };
      } else {
        delete lane[entry.model];
      }
      detectedBudgets[laneId] = lane; // lane may be empty — the connection key itself stays
      settings.detectedBudgets = detectedBudgets;
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
      if (duration && duration <= horizonMs) {
        kept.push({ ...entry, at: new Date(now + duration).toISOString() });
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

  await updateSettingsFn({ quotaRecheck: kept });
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
