/**
 * Concurrency sampler (Part 2 of the 2026-11-16 concurrency design).
 *
 * Every 30s one row lands in concurrencySamples: Σ in-flight requests (the
 * chatCore-tracked traffic — probes deliberately don't track) and the
 * system's total concurrency budget at that instant. The Usage tab's
 * Concurrency chart reads these rows; nothing else does.
 *
 * The budget mirrors comboSummary's lane arithmetic, minus combos: every
 * active connection counts once at its max effective budget across models —
 * measured models at their detected budgets, unmeasured models at the global
 * account limit (a lane measured on only some of its provider's models is
 * ceilinged at the global, review minor M6). One deliberate deviation keeps
 * the collapse visible: a lane holding a quota-collapsed model counts its
 * measured max, never the global lift (a live-quota collapse means 0 — the
 * lane is closed, not the global default). Custom nodes (openai-compatible-*)
 * serve dynamic model lists and keep the measured-max signal; every keyless
 * provider with no connections counts one shared lane clamped by
 * keylessLaneLimit.
 */

import { getSettings, getProviderConnections } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { getActiveRequests, recordConcurrencySample, pruneConcurrencySamples } from "@/lib/db/repos/usageRepo.js";
import { accountInflightLimit } from "@/sse/services/accountInflight.js";
import { keylessLaneLimit } from "@/sse/services/fanoutBudget.js";
import { FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getProviderModels } from "open-sse/config/providerModels.js";

const RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

const isActiveConnection = (c) => c.isActive === true || c.isactive === "1";

const maxDetectedBudget = (lane) => {
  const values = lane && typeof lane === "object" ? Object.values(lane) : [];
  const budgets = values.map((v) => Number(v?.budget)).filter((n) => Number.isFinite(n));
  return budgets.length ? Math.max(...budgets) : null;
};

const isCollapsedEntry = (v) => v?.quota === true && Number(v?.budget) === 0;

/**
 * One connection's max EFFECTIVE budget across its models (the spec's
 * sampler rule): a measured model counts its detected budget, an unmeasured
 * model admits at the global limit — so a lane measured on SOME of its
 * provider's models is effectively ceilinged at the global, not the measured
 * max (review minor M6). Two documented deviations from the naive lift:
 * - A collapsed lane (any quota-collapsed model) counts its measured max —
 *   lifting it to the global would hide the very squeeze this chart exists
 *   to show; the combo card and the queue line carry the per-model detail.
 * - Custom nodes (openai-compatible-*) serve dynamic model lists — no
 *   coverage notion exists, so the measured max stays the signal there.
 * Returns null when the lane has no measured entries (caller uses global).
 * @param {object} lane
 * @param {string} providerId
 * @param {number} global
 * @returns {number|null}
 */
const laneEffectiveBudget = (lane, providerId, global) => {
  const measured = maxDetectedBudget(lane);
  if (measured === null) return null;
  if (providerId?.startsWith?.("openai-compatible-")) return measured;
  const known = getProviderModels(providerId);
  if (!known?.length) return measured;
  const laneKeys = lane && typeof lane === "object" ? Object.keys(lane) : [];
  if (laneKeys.some((k) => lane[k] && isCollapsedEntry(lane[k]))) return measured;
  const unmeasured = known.some((m) => lane?.[m?.id] == null);
  return unmeasured ? Math.max(measured, global) : measured;
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
    const budget = laneEffectiveBudget(detected[c.id], c.provider, global);
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
    await pruneConcurrencySamples(await getAdapter(), new Date(at.getTime() - RETENTION_MS).toISOString());
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
