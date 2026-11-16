/**
 * Concurrency sampler (Part 2 of the 2026-11-16 concurrency design).
 *
 * Every 30s one row lands in concurrencySamples: Σ in-flight requests (the
 * chatCore-tracked traffic — probes deliberately don't track) and the
 * system's total concurrency budget at that instant. The Usage tab's
 * Concurrency chart reads these rows; nothing else does.
 *
 * The budget mirrors comboSummary's lane arithmetic, minus combos: every
 * active connection counts once at its max detected budget (a live-quota
 * collapse means 0 — the lane is closed, not the global default), else the
 * global account limit; every keyless provider with no connections counts
 * one shared lane clamped by keylessLaneLimit.
 */

import { getSettings, getProviderConnections } from "@/lib/localDb";
import { getActiveRequests, recordConcurrencySample, pruneConcurrencySamples } from "@/lib/db/repos/usageRepo.js";
import { accountInflightLimit } from "@/sse/services/accountInflight.js";
import { keylessLaneLimit } from "@/sse/services/fanoutBudget.js";
import { FREE_PROVIDERS } from "@/shared/constants/providers.js";

const RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

const isActiveConnection = (c) => c.isActive === true || c.isactive === "1";

const maxDetectedBudget = (lane) => {
  const values = lane && typeof lane === "object" ? Object.values(lane) : [];
  const budgets = values.map((v) => Number(v?.budget)).filter((n) => Number.isFinite(n));
  return budgets.length ? Math.max(...budgets) : null;
};

/**
 * Total concurrency the whole router could run right now, across real
 * connections and keyless lanes.
 * @param {{ settings?: object, connections?: object[], globalLimit?: number }} input
 * @returns {Promise<number>}
 */
export async function systemConcurrencyBudget({ settings, connections, globalLimit } = {}) {
  const global = Number.isFinite(Number(globalLimit)) ? Number(globalLimit) : accountInflightLimit();
  const detected = settings?.detectedBudgets && typeof settings.detectedBudgets === "object" ? settings.detectedBudgets : {};
  const active = (connections || []).filter(isActiveConnection);
  let total = 0;
  for (const c of active) {
    const budget = maxDetectedBudget(detected[c.id]);
    total += budget === null ? global : budget;
  }
  // One shared keyless lane per noAuth provider that no active connection serves.
  const servedProviders = new Set(active.map((c) => c.provider));
  for (const [pid, def] of Object.entries(FREE_PROVIDERS)) {
    if (!def?.noAuth || servedProviders.has(pid)) continue;
    total += keylessLaneLimit(maxDetectedBudget(detected[pid]) ?? global, settings);
  }
  return total;
}

/**
 * One sampler tick. Prunes only on the top of the hour — retention work runs
 * hourly, sampling runs every 30s.
 * @param {{ now?: Date, globalLimit?: number }} [deps]
 * @returns {Promise<{ inflight: number, totalBudget: number }>}
 */
export async function sampleOnce(deps = {}) {
  const { now = new Date(), globalLimit } = deps;
  const at = now instanceof Date ? now : new Date(now);
  const [{ activeRequests }, settings, connections] = await Promise.all([
    getActiveRequests(),
    getSettings(),
    getProviderConnections({}),
  ]);
  const inflight = (activeRequests || []).reduce((sum, r) => sum + (Number(r?.count) || 0), 0);
  const totalBudget = await systemConcurrencyBudget({ settings, connections, globalLimit });
  await recordConcurrencySample(inflight, String(totalBudget), { now: at });
  // Retention runs once per HOUR: the 30s scheduler puts two ticks inside
  // minute 0 (:00-phase and :30-phase); only the first half of the minute
  // prunes, so exactly one of the two fires. The DELETE is idempotent anyway.
  if (at.getUTCMinutes() === 0 && at.getUTCSeconds() < 30) {
    await pruneConcurrencySamples(await (await import("@/lib/db/driver.js")).getAdapter(), new Date(at.getTime() - RETENTION_MS).toISOString());
  }
  return { inflight, totalBudget };
}

let schedulerHandle = null;

/**
 * Start the 30s sampler (one interval per process, unref()d). Idempotent:
 * later calls return the existing handle.
 * @returns {{ stop: () => void }}
 */
export function ensureConcurrencyScheduler(deps) {
  if (schedulerHandle) return schedulerHandle;
  const timer = setInterval(() => { sampleOnce(deps).catch(() => {}); }, 30 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  schedulerHandle = { stop: () => { clearInterval(timer); schedulerHandle = null; } };
  return schedulerHandle;
}

/** Test-only: drop the module-level handle so a fresh test gets its own. */
export function resetConcurrencyScheduler() {
  schedulerHandle?.stop();
}
