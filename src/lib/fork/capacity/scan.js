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
import registry from "open-sse/providers/registry/index.js";
import { probeConnectionModel, dispatchFor } from "./probe.js";

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
 * Providers served WITHOUT credentials (registry `noAuth`) — live traffic
 * reaches them through the virtual "noauth" lane, so they have no connection
 * rows for the scan to iterate. Read at call time so the registry stays the
 * single source of truth.
 * @returns {string[]}
 */
export const registryKeylessProviders = () =>
  (Array.isArray(registry) ? registry : []).filter((p) => p?.noAuth === true && p.id).map((p) => p.id);

/**
 * Run the whole system scan. All I/O injected; see the module doc for the
 * semantics. probeFn mirrors probeConnectionModel's signature and adds
 * `requests` (upstream dispatch count) to its result for the audit trail.
 * @param {object} deps
 * @param {object} [deps.getSettings] …each defaults to the real implementation
 * @returns {Promise<{scanned: number, detected: number, skipped: number, unknown: number, probeRequests: number, perProvider: {provider: string, reason: string, count: number}[]} | {alreadyRunning: true}>}
 */
// In-process mutex: two racing callers (POST + scheduler tick) can both pass
// the persisted-running guard below before either write lands — the mutex
// closes that window synchronously. The settings flag stays as the
// cross-instance guard.
let scanInFlight = false;

export async function runCapacityScan({
  getSettings: getSettingsDep = getSettings,
  updateSettings: updateSettingsDep = updateSettings,
  getProviderConnections: getConnectionsDep = getProviderConnections,
  getInflightCount: getInflightDep = getInflightCount,
  checkAndRefreshToken: refreshDep = checkAndRefreshToken,
  probeFn = ({ provider, connection, model, maxLevel }) =>
    probeConnectionModel({ provider, connection, model, maxLevel, dispatch: dispatchFor(provider) }),
  now = () => Date.now(),
  parallelism = 4,
  provider = null,
  keylessProviders = registryKeylessProviders,
} = {}) {
  if (scanInFlight) return { alreadyRunning: true };
  scanInFlight = true;
  try {
    return await runCapacityScanLocked({ getSettingsDep, updateSettingsDep, getConnectionsDep, getInflightDep, refreshDep, probeFn, now, parallelism, provider, keylessProviders });
  } finally {
    scanInFlight = false;
  }
}

async function runCapacityScanLocked({
  getSettingsDep,
  updateSettingsDep,
  getConnectionsDep,
  getInflightDep,
  refreshDep,
  probeFn,
  now,
  parallelism,
  provider = null,
  keylessProviders,
}) {
  const settings = await getSettingsDep();
  const state = settings?.capacityScan && typeof settings.capacityScan === "object" ? settings.capacityScan : {};
  if (state.running) return { ...(state.lastResult || {}), alreadyRunning: true };

  // Operator knobs (review minor 3): settings win when they parse; the dep
  // default applies otherwise. maxLevel caps the probe's ramp (values >32 are
  // naturally capped — the ramp itself tops out at 32); parallelism is capped
  // so a fat-fingered value cannot stampede every upstream at once.
  const maxLevelSetting = Number.parseInt(state.maxLevel, 10);
  const maxLevel = Number.isFinite(maxLevelSetting) && maxLevelSetting >= 1 ? maxLevelSetting : 32;
  const parallelismSetting = Number.parseInt(state.parallelism, 10);
  const poolSize = Number.isFinite(parallelismSetting) && parallelismSetting >= 1
    ? Math.min(parallelismSetting, 16)
    : Math.max(1, Number(parallelism) || 4);

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

  // Provider-scoped run (the provider card's own "Chạy chuẩn đoán"): the
  // filter applies BEFORE the skip tallies — out-of-scope connections are
  // invisible, and the result describes only the scoped provider.
  const connections = (await getConnectionsDep({}))
    .filter(isActiveConnection)
    .filter((c) => !provider || c.provider === provider);
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
    tasks.push({ provider, connection, models });
  }

  // Keyless providers: no connection rows exist, so measure the shared lane at
  // PROVIDER level — one virtual connection {id: providerId}, stored under
  // detectedBudgets[providerId]. A provider that also has real connections is
  // measured per key above instead (capacity is per key, never aggregated).
  // Providers with no diagnostic models are invisible, not skipped.
  const connectedProviders = new Set(connections.map((c) => c.provider));
  for (const pid of new Set(keylessProviders())) {
    if (provider && pid !== provider) continue;
    if (connectedProviders.has(pid)) continue;
    const dm = settings?.diagnosticModels?.[pid];
    const models = Array.isArray(dm) ? [...new Set(dm.filter((m) => typeof m === "string" && m))] : [];
    if (!models.length) continue;
    if (getInflightDep(pid) > 0) { skipped += 1; tally(pid, "busy (inflight > 0)"); continue; }
    tasks.push({ provider: pid, connection: { id: pid, provider: pid, isActive: true }, models, keyless: true });
  }

  // One task per CONNECTION: the refresh rides the worker pool (review minor
  // 5 — a slow refresh no longer delays every later connection's probes).
  const runTask = async ({ provider, connection, models, keyless = false }) => {
    // Credential prep: the exact refresh the live chat path runs. It RETURNS
    // the refreshed creds (and persists them) — the probe must use the
    // returned object, or an expired OAuth token is refreshed and then
    // probed with the stale copy (401 every day). A failed refresh marks the
    // whole connection unknown (auth) — its models are not probed and any
    // previous detected value stands.
    let fresh = connection;
    try {
      if (!keyless) fresh = await refreshDep(provider, connection); // keyless: no credentials to refresh
    } catch {
      unknown += models.length;
      tally(provider, "auth");
      return;
    }
    // Re-check busy at probe time (review minor 4): traffic that arrived
    // while this task waited in the pool would read LOW and then govern
    // routing for a day — skip instead, next scan tries again.
    if (getInflightDep(fresh.id) > 0) {
      skipped += 1;
      tally(provider, "busy (inflight > 0)");
      return;
    }
    scanned += 1;
    for (const model of models) {
      let result;
      try {
        result = await probeFn({ provider, connection: fresh, model, maxLevel });
      } catch (e) {
        result = { status: "unreachable", reason: String(e?.message || e) };
      }
      probeRequests += Number.isInteger(result.requests) ? result.requests : 0;
      if (result.status === "ok" && Number.isInteger(result.budget) && result.budget >= 1) {
        detectedBudgets[fresh.id] = detectedBudgets[fresh.id] || {};
        detectedBudgets[fresh.id][model] = { budget: result.budget, detectedAt: new Date(now()).toISOString() };
        detected += 1;
      } else {
        // keep the previous detected value; only a measurement moves it
        unknown += 1;
        tally(provider, result.status === "unsupported" ? "unsupported provider" : String(result.status || "unknown"));
      }
    }
  };
  // simple worker pool over the task list
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(poolSize, tasks.length)) }, async () => {
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
    ...(provider ? { provider } : {}),
    perProvider: [...reasonCounts.entries()].map(([key, count]) => {
      const [provider, reason] = key.split("|");
      return { provider, reason, count };
    }),
  };
  // The final write must not resurrect the start-of-scan snapshot: an
  // operator change made while the scan ran (enabled off, intervalHours
  // edited) lives in a FRESH settings read, and this write spreads that.
  let freshState = state;
  try {
    const fresh = await getSettingsDep();
    if (fresh?.capacityScan && typeof fresh.capacityScan === "object") freshState = fresh.capacityScan;
  } catch (e) {
    console.warn("[CAPACITY] final settings re-read failed; using start snapshot:", e?.message || e);
  }
  // A provider-scoped run is a manual diagnostic, not a daily tick: it keeps
  // the fresh state's lastRunAt/nextRunAt (the full scan owns the schedule)
  // and only clears running + records its labeled result.
  await updateSettingsDep({
    detectedBudgets,
    capacityScan: provider
      ? { ...freshState, running: false, lastResult }
      : { ...freshState, running: false, lastRunAt: new Date(finishedAt).toISOString(), lastResult, nextRunAt: new Date(finishedAt + intervalHours * HOUR_MS).toISOString() },
  });
  return lastResult;
}

const HOUR_MS = 3600 * 1000;

let schedulerHandle = null;

// Boot calls ensureCapacityScheduler() with no arguments; tests inject fakes.
const schedulerDeps = (deps = {}) => ({
  getSettings, updateSettings, getProviderConnections, getInflightCount, checkAndRefreshToken,
  now: () => Date.now(),
  ...deps,
});

async function schedulerTick(rawDeps) {
  const deps = schedulerDeps(rawDeps);
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
  } catch (e) {
    // the stale-running rule recovers a crashed scan on a later tick, but a
    // persistently failing scan must at least be visible in the logs
    console.warn("[CAPACITY] scheduled scan failed:", e?.message || e);
  }
}

/**
 * Start the capacity scheduler (one 15-minute interval per process,
 * unref()d). Idempotent: later calls return the existing handle. Call with no
 * arguments at boot to use the real settings/DB wiring.
 * @param {Parameters<runCapacityScan>[0]} [deps]
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
