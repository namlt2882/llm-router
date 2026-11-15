/**
 * Capacity auto-detect: system-wide scan orchestrator (patch #20;
 * docs/wavebot-patches.md).
 *
 * One scan a day (settings.capacityScan.intervalHours, default 24) walks every
 * active connection, probes each configured diagnostic model at ramp levels
 * through the provider DIRECTLY (never through the router's own account
 * selection — that would acquire the very in-flight slots it measures), and
 * writes settings.detectedBudgets[connId][model] = { budget, detectedAt }.
 * A pair that fails to probe keeps its previous budget — a refusal never
 * lowers or clears a measured value; only a successful measurement moves it.
 *
 * Every use is dependency-injected (settings, connections, inflight, token
 * refresh, probe) so tests run the real orchestration against fakes.
 */
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh.js";
import { getSettings, updateSettings, getProviderConnections } from "@/lib/localDb";
import { getInflightCount } from "@/sse/services/accountInflight.js";
import { probeConnectionModel } from "./probe.js";

const STALE_RUNNING_MS = 30 * 60 * 1000;

/**
 * Diagnostic models configured for one connection: the connection-id key
 * first, then the provider key (compatible nodes share a provider's list).
 * Deduped, order kept; [] when nothing is configured.
 * @param {{ id?: string, provider?: string }} connection
 * @param {Record<string, string[]> | null | undefined} diagnosticModels
 * @returns {string[]}
 */
export function resolveDiagnosticModels(connection, diagnosticModels) {
  if (!diagnosticModels || typeof diagnosticModels !== "object") return [];
  const own = diagnosticModels[connection?.id] ?? diagnosticModels[connection?.provider];
  if (!Array.isArray(own)) return [];
  return [...new Set(own.filter((m) => typeof m === "string" && m))];
}

/**
 * Whether the scheduled scan should start now. A run stuck in `running` for
 * more than 30 minutes is dead (a crashed process can no longer clear its
 * flag) and counts as due again.
 * @param {{ enabled?: unknown, nextRunAt?: unknown, running?: unknown, runningSince?: unknown }} state
 * @param {number} now epoch ms
 * @param {number} [staleRunningMs]
 * @returns {boolean}
 */
export function isDue(state, now, staleRunningMs = STALE_RUNNING_MS) {
  if (!state?.enabled) return false;
  const next = Date.parse(state.nextRunAt || "");
  if (Number.isFinite(next) && now < next) return false;
  if (state.running) {
    const since = Date.parse(state.runningSince || "");
    return !(Number.isFinite(since) && now - since <= staleRunningMs);
  }
  return true;
}

const isActiveConnection = (c) => c.isActive === true || c.isactive === "1";

/**
 * Run the whole system scan. All I/O injected; see the module doc for the
 * semantics. probeFn mirrors probeConnectionModel's signature and adds
 * `requests` (upstream dispatch count) to its result for the audit trail.
 * @param {object} deps
 * @param {object} [deps.getSettings] …each defaults to the real implementation
 * @returns {Promise<{scanned: number, detected: number, skipped: number, unknown: number, probeRequests: number, perProvider: {provider: string, reason: string, count: number}[]} | {alreadyRunning: true}>}
 */
export async function runCapacityScan({
  getSettings: getSettingsDep = getSettings,
  updateSettings: updateSettingsDep = updateSettings,
  getProviderConnections: getConnectionsDep = getProviderConnections,
  getInflightCount: getInflightDep = getInflightCount,
  checkAndRefreshToken: refreshDep = checkAndRefreshToken,
  probeFn = ({ provider, connection, model }) => probeConnectionModel({ provider, connection, model }),
  now = () => Date.now(),
  parallelism = 4,
} = {}) {
  const settings = await getSettingsDep();
  const state = settings?.capacityScan && typeof settings.capacityScan === "object" ? settings.capacityScan : {};
  if (state.running) return { ...(state.lastResult || {}), alreadyRunning: true };

  const startedAt = new Date(now()).toISOString();
  // Persist running BEFORE any probe so a crash mid-scan is visible; the
  // stale-running rule in isDue clears it on a later tick.
  await updateSettingsDep({ capacityScan: { ...state, running: true, runningSince: startedAt } });

  const detectedBudgets = settings?.detectedBudgets && typeof settings.detectedBudgets === "object"
    ? structuredClone(settings.detectedBudgets)
    : {};
  const reasonCounts = new Map(); // "provider|reason" → count
  const tally = (provider, reason, count = 1) => {
    const key = `${provider}|${reason}`;
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + count);
  };

  let scanned = 0, detected = 0, skipped = 0, unknown = 0, probeRequests = 0;

  const connections = (await getConnectionsDep({})).filter(isActiveConnection);
  const tasks = [];
  for (const connection of connections) {
    const provider = connection.provider;
    const models = resolveDiagnosticModels(connection, settings?.diagnosticModels);
    if (!models.length) { skipped += 1; tally(provider, "no diagnostic models"); continue; }
    if (connection.providerSpecificData?.connectionProxyEnabled === true) {
      skipped += 1; tally(provider, "proxied (not probed in v1)"); continue;
    }
    if (getInflightDep(connection.id) > 0) {
      skipped += 1; tally(provider, "busy (inflight > 0)"); continue;
    }
    // Credential prep: the exact refresh the live chat path runs. A failed
    // refresh marks the whole connection unknown (auth) — its models are not
    // probed and any previous detected value stands.
    try {
      await refreshDep(provider, connection);
    } catch {
      unknown += models.length;
      tally(provider, "auth");
      continue;
    }
    scanned += 1;
    for (const model of models) tasks.push({ provider, connection, model });
  }

  const runTask = async ({ provider, connection, model }) => {
    let result;
    try {
      result = await probeFn({ provider, connection, model });
    } catch (e) {
      result = { status: "unreachable", reason: String(e?.message || e) };
    }
    probeRequests += Number.isInteger(result.requests) ? result.requests : 0;
    if (result.status === "ok" && Number.isInteger(result.budget) && result.budget >= 1) {
      detectedBudgets[connection.id] = detectedBudgets[connection.id] || {};
      detectedBudgets[connection.id][model] = { budget: result.budget, detectedAt: new Date(now()).toISOString() };
      detected += 1;
    } else {
      // keep the previous detected value; only a measurement moves it
      unknown += 1;
      tally(provider, result.status === "unsupported" ? "unsupported provider" : String(result.status || "unknown"));
    }
  };
  // simple worker pool over the task list
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(parallelism, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await runTask(task);
    }
  });
  await Promise.all(workers);

  const finishedAt = now();
  const intervalHours = Number.isFinite(Number(state.intervalHours)) && Number(state.intervalHours) > 0
    ? Number(state.intervalHours)
    : 24;
  const lastResult = {
    scanned, detected, skipped, unknown, probeRequests,
    perProvider: [...reasonCounts.entries()].map(([key, count]) => {
      const [provider, reason] = key.split("|");
      return { provider, reason, count };
    }),
  };
  await updateSettingsDep({
    detectedBudgets,
    capacityScan: { ...state, running: false, lastRunAt: new Date(finishedAt).toISOString(), lastResult, nextRunAt: new Date(finishedAt + intervalHours * HOUR_MS).toISOString() },
  });
  return lastResult;
}

const HOUR_MS = 3600 * 1000;

let schedulerHandle = null;

async function schedulerTick(deps) {
  const settings = await deps.getSettings();
  const state = settings?.capacityScan && typeof settings.capacityScan === "object" ? settings.capacityScan : {};
  // Never scanned before: stagger the first run randomly within 6 hours so a
  // fleet of routers does not probe in lockstep at boot.
  if (!state.nextRunAt) {
    await deps.updateSettings({ capacityScan: { ...state, nextRunAt: new Date(Date.now() + Math.random() * 6 * HOUR_MS).toISOString() } });
    return;
  }
  if (!isDue(state, Date.now())) return;
  try {
    await runCapacityScan(deps);
  } catch { /* the stale-running rule recovers a crashed scan on a later tick */ }
}

/**
 * Start the capacity scheduler (one 15-minute interval per process,
 * unref()d). Idempotent: later calls return the existing handle.
 * @param {Parameters<runCapacityScan>[0]} deps
 * @returns {{ stop: () => void }}
 */
export function ensureCapacityScheduler(deps) {
  if (schedulerHandle) return schedulerHandle;
  const timer = setInterval(() => { schedulerTick(deps).catch(() => {}); }, 15 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  schedulerHandle = { stop: () => { clearInterval(timer); schedulerHandle = null; } };
  return schedulerHandle;
}

/** Test-only: drop the module-level handle so a fresh test gets its own. */
export function resetCapacityScheduler() {
  schedulerHandle?.stop();
}
