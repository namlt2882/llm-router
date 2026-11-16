import { beforeEach, describe, expect, it, vi } from "vitest";

// scan.js resolves these at module top; every USE is via injected deps — the
// mocks keep the module import free of real pg/redis wiring.
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => [],
  getSettings: async () => ({}),
  updateSettings: async () => {},
}));
vi.mock("@/sse/services/accountInflight.js", () => ({ getInflightCount: () => 0 }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c }));
// probe.js resolves this at import; the scan tests inject probeFn so the
// registry itself is never consulted.
vi.mock("open-sse/providers/registry/index.js", () => ({ default: [] }));

const { resolveDiagnosticModels, isDue, runCapacityScan, ensureCapacityScheduler, resetCapacityScheduler }
  = await import("../../src/lib/fork/capacity/scan.js");

const HOUR = 3600 * 1000;

// In-memory environment: a settings map, fixture connections, a fake probe.
const makeEnv = () => {
  const env = {
    settings: {},
    connections: [],
    inflight: {},
    probeResults: {}, // "connId:model" → non-default probe result
    failRefreshFor: null,
    failUpdatesAfter: null, // N updates succeed, later ones throw
    updates: [],
    probes: [],
    refreshes: [],
    currentTime: 1_700_000_000_000,
    now: () => env.currentTime,
  };
  env.getSettings = async () => env.settings;
  env.updateSettings = async (patch) => {
    env.updates.push(patch);
    if (env.failUpdatesAfter !== null && env.updates.length > env.failUpdatesAfter) throw new Error("db down");
    env.settings = { ...env.settings, ...patch };
  };
  env.getProviderConnections = async () => env.connections;
  env.getInflightCount = (id) => env.inflight[id] || 0;
  env.checkAndRefreshToken = async (_provider, conn) => {
    env.refreshes.push(conn.id);
    if (env.failRefreshFor === conn.id) throw new Error("refresh failed");
    return conn;
  };
  env.probeFn = async ({ connection, model }) => {
    env.probes.push(`${connection.id}:${model}`);
    return env.probeResults[`${connection.id}:${model}`] || { status: "ok", budget: 5, requests: 26 };
  };
  env.scanDeps = () => ({
    getSettings: env.getSettings,
    updateSettings: env.updateSettings,
    getProviderConnections: env.getProviderConnections,
    getInflightCount: env.getInflightCount,
    checkAndRefreshToken: env.checkAndRefreshToken,
    probeFn: env.probeFn,
    now: env.now,
  });
  return env;
};

const conn = (id, over = {}) => ({ id, provider: "glm", isActive: true, ...over });

beforeEach(() => {
  resetCapacityScheduler();
});

describe("resolveDiagnosticModels", () => {
  it("connection-id key wins over the provider key", () => {
    const dm = { "conn-1": ["m-a"], glm: ["m-b"] };
    expect(resolveDiagnosticModels({ id: "conn-1", provider: "glm" }, dm)).toEqual(["m-a"]);
    expect(resolveDiagnosticModels({ id: "conn-9", provider: "glm" }, dm)).toEqual(["m-b"]);
  });

  it("dedupes keeping order and returns [] for empty/missing entries", () => {
    expect(resolveDiagnosticModels({ id: "c", provider: "glm" }, { glm: ["x", "x", "y"] })).toEqual(["x", "y"]);
    expect(resolveDiagnosticModels({ id: "c", provider: "glm" }, {})).toEqual([]);
    expect(resolveDiagnosticModels({ id: "c", provider: "glm" }, { glm: [] })).toEqual([]);
    expect(resolveDiagnosticModels({ id: "c", provider: "glm" }, null)).toEqual([]);
  });
});

describe("isDue", () => {
  const T = 1_700_000_000_000;
  it("due when enabled, past nextRunAt, not running", () => {
    expect(isDue({ enabled: true, nextRunAt: new Date(T - 1).toISOString() }, T)).toBe(true);
    expect(isDue({ enabled: true, nextRunAt: new Date(T + 1).toISOString() }, T)).toBe(false);
    expect(isDue({ enabled: true }, T)).toBe(true); // never scanned → due now
  });

  it("a fresh run blocks; a run stuck for > 30 min counts as dead and is due again", () => {
    expect(isDue({ enabled: true, running: true, runningSince: new Date(T - 5 * 60e3).toISOString() }, T)).toBe(false);
    expect(isDue({ enabled: true, running: true, runningSince: new Date(T - 31 * 60e3).toISOString() }, T)).toBe(true);
  });

  it("disabled never runs", () => {
    expect(isDue({ enabled: false }, T)).toBe(false);
    expect(isDue({}, T)).toBe(false);
  });
});

describe("runCapacityScan", () => {
  it("merges budgets, keeps the previous value on unknown, tallies skips + probe traffic, reschedules", async () => {
    const env = makeEnv();
    env.connections = [
      conn("c-ok"),
      conn("c-busy"),
      conn("c-auth"),
      conn("c-proxy", { providerSpecificData: { connectionProxyEnabled: true } }),
      conn("c-nomodels"),
    ];
    env.settings = {
      capacityScan: { enabled: true },
      diagnosticModels: { "c-ok": ["m1", "m2"], "c-busy": ["m9"], "c-auth": ["m3"], "c-proxy": ["p1"] },
      detectedBudgets: { "c-ok": { m2: { budget: 3, detectedAt: "old" } } },
    };
    env.inflight = { "c-busy": 1 };
    env.failRefreshFor = "c-auth";
    env.probeResults = { "c-ok:m2": { status: "throttle", reason: "rate limit", requests: 15 } };

    const result = await runCapacityScan(env.scanDeps());

    // tallies: 1 detected (m1), 2 unknown (m2 throttle + c-auth whole connection), 3 skipped
    expect(result.detected).toBe(1);
    expect(result.unknown).toBe(2);
    expect(result.skipped).toBe(3);
    expect(result.probeRequests).toBe(41); // 26 (m1) + 15 (m2)
    const reasons = result.perProvider.map((r) => `${r.reason}:${r.count}`);
    expect(reasons).toContain("no diagnostic models:1");
    expect(reasons).toContain("busy (inflight > 0):1");
    expect(reasons).toContain("proxied (not probed in v1):1");
    expect(reasons).toContain("throttle:1");
    expect(reasons).toContain("auth:1");

    // budgets: m1 overwritten fresh, m2 keeps its previous value
    const detected = env.settings.detectedBudgets["c-ok"];
    expect(detected.m1.budget).toBe(5);
    expect(detected.m1.detectedAt).not.toBe("old");
    expect(detected.m2).toEqual({ budget: 3, detectedAt: "old" });

    // the running flag was persisted BEFORE probing…
    expect(env.updates[0].capacityScan.running).toBe(true);
    expect(env.updates[0].capacityScan.runningSince).toBeTruthy();
    // …and cleared on the final persist, with the next run scheduled
    expect(env.settings.capacityScan.running).toBe(false);
    expect(env.settings.capacityScan.lastRunAt).toBeTruthy();
    expect(new Date(env.settings.capacityScan.nextRunAt).getTime())
      .toBe(env.currentTime + 24 * HOUR); // intervalHours default 24

    // only the healthy connection's models were probed
    expect(env.probes).toEqual(["c-ok:m1", "c-ok:m2"]);
  });

  it("a re-entrant call while a scan is running returns alreadyRunning and fires nothing", async () => {
    const env = makeEnv();
    env.connections = [conn("c-ok")];
    env.settings = { capacityScan: { enabled: true, running: true, runningSince: new Date().toISOString() }, diagnosticModels: { "c-ok": ["m1"] } };
    const result = await runCapacityScan(env.scanDeps());
    expect(result.alreadyRunning).toBe(true);
    expect(env.probes).toEqual([]);
  });

  it("an intervalHours setting shifts the next run", async () => {
    const env = makeEnv();
    env.connections = [conn("c-ok")];
    env.settings = { capacityScan: { enabled: true, intervalHours: 6 }, diagnosticModels: { "c-ok": ["m1"] } };
    await runCapacityScan(env.scanDeps());
    expect(new Date(env.settings.capacityScan.nextRunAt).getTime()).toBe(env.currentTime + 6 * HOUR);
  });

  it("a failing final persist leaves the running flag set (the stale rule clears it next tick)", async () => {
    const env = makeEnv();
    env.connections = [conn("c-ok")];
    env.settings = { capacityScan: { enabled: true }, diagnosticModels: { "c-ok": ["m1"] } };
    env.failUpdatesAfter = 1; // running-flag persist ok, final persist throws
    await expect(runCapacityScan(env.scanDeps())).rejects.toThrow("db down");
    expect(env.settings.capacityScan.running).toBe(true);
  });
});

describe("ensureCapacityScheduler", () => {
  it("starts one interval, staggers the first run, then scans when due; idempotent", async () => {
    vi.useFakeTimers();
    try {
      const env = makeEnv();
      env.now = () => Date.now();
      env.connections = [conn("c-ok")];
      env.settings = { capacityScan: { enabled: true }, diagnosticModels: { "c-ok": ["m1"] } };

      const handle = ensureCapacityScheduler(env.scanDeps());
      expect(ensureCapacityScheduler(env.scanDeps())).toBe(handle); // idempotent

      // first tick: nextRunAt unset → stagger only, no probe traffic
      await vi.advanceTimersByTimeAsync(15 * 60e3);
      expect(env.probes).toEqual([]);
      expect(env.settings.capacityScan.nextRunAt).toBeTruthy();

      // force it due, next tick runs the scan
      env.settings.capacityScan.nextRunAt = new Date(Date.now() - 1).toISOString();
      await vi.advanceTimersByTimeAsync(15 * 60e3);
      expect(env.probes).toContain("c-ok:m1");
      expect(env.settings.capacityScan.running).toBe(false);

      handle.stop();
      // after stop, ticks do nothing
      const probesAfter = env.probes.length;
      env.settings.capacityScan.nextRunAt = new Date(Date.now() - 1).toISOString();
      await vi.advanceTimersByTimeAsync(60 * 60e3);
      expect(env.probes.length).toBe(probesAfter);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a disabled scan is never scheduled even when due", async () => {
    vi.useFakeTimers();
    try {
      const env = makeEnv();
      env.now = () => Date.now();
      env.connections = [conn("c-ok")];
      env.settings = { capacityScan: { enabled: false }, diagnosticModels: { "c-ok": ["m1"] } };
      const handle = ensureCapacityScheduler(env.scanDeps());
      await vi.advanceTimersByTimeAsync(2 * 15 * 60e3);
      expect(env.probes).toEqual([]);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Final-review fixes (2026-11-16): the scan must hand the probe the REFRESHED
// credentials, and a scan in flight must be an in-process mutex whose final
// write merges fresh settings — a mid-scan operator change must not be
// reverted, and two racing runs must not double the probe traffic.
describe("review fixes: refreshed creds + scan mutex", () => {
  it("the probe receives checkAndRefreshToken's REFRESHED connection, not the stale row", async () => {
    const env = makeEnv();
    env.connections = [conn("c1", { data: { accessToken: "stale" } })];
    env.settings = { diagnosticModels: { c1: ["m1"] } };
    const probedConnections = [];
    const originalProbe = env.probeFn;
    env.probeFn = async (task) => {
      probedConnections.push(task.connection);
      return originalProbe(task);
    };
    env.checkAndRefreshToken = async (_provider, c) => {
      env.refreshes.push(c.id);
      return { ...c, data: { accessToken: "refreshed" } };
    };
    await runCapacityScan(env.scanDeps());
    expect(env.refreshes).toEqual(["c1"]);
    expect(probedConnections[0].data.accessToken).toBe("refreshed");
  });

  it("the final write merges the FRESH capacityScan — a mid-scan operator change is not reverted", async () => {
    const env = makeEnv();
    env.connections = [conn("c1")];
    env.settings.capacityScan = { enabled: true, intervalHours: 24 };
    const originalUpdate = env.updateSettings;
    env.updateSettings = async (patch) => {
      await originalUpdate(patch);
      // An operator disables the scan while it runs — right after the
      // running:true persist, before the final write.
      if (patch.capacityScan?.running === true) {
        env.settings = { ...env.settings, capacityScan: { ...env.settings.capacityScan, enabled: false, intervalHours: 6 } };
      }
    };
    await runCapacityScan(env.scanDeps());
    const finalState = env.settings.capacityScan;
    expect(finalState.enabled).toBe(false);
    expect(finalState.intervalHours).toBe(6);
    expect(finalState.running).toBe(false);
    expect(finalState.lastResult).toBeTruthy();
    expect(finalState.nextRunAt).toBeTruthy();
  });

  it("an in-flight scan is a mutex: a second concurrent run refuses, it never doubles the probes", async () => {
    const env = makeEnv();
    env.connections = [conn("c1")];
    env.settings = { diagnosticModels: { c1: ["m1"] } };
    const [r1, r2] = await Promise.all([runCapacityScan(env.scanDeps()), runCapacityScan(env.scanDeps())]);
    const winner = [r1, r2].find((r) => !r.alreadyRunning);
    const loser = [r1, r2].find((r) => r.alreadyRunning);
    expect(winner).toBeTruthy();
    expect(loser).toBeTruthy();
    expect(env.probes.length).toBe(1);
    // exactly one scan persisted a running flag
    expect(env.updates.filter((u) => u.capacityScan?.running === true).length).toBe(1);
  });
});

// Review minors 3/4/5 (2026-11-16): maxLevel + parallelism come from the
// capacityScan settings and reach the probe; the busy check runs again at
// probe time; the token refresh rides the worker pool instead of a serial
// upfront loop.
describe("review minors: knobs, late busy, pooled refresh", () => {
  it("threads settings maxLevel to the probe (minor 3)", async () => {
    const env = makeEnv();
    env.connections = [conn("c1")];
    env.settings = { diagnosticModels: { c1: ["m1"] }, capacityScan: { maxLevel: 8 } };
    const seen = [];
    env.probeFn = async (task) => { seen.push(task.maxLevel); return { status: "ok", budget: 4, requests: 1 }; };
    await runCapacityScan(env.scanDeps());
    expect(seen).toEqual([8]);
  });

  it("re-checks busy at probe time — traffic that arrived mid-scan is skipped, not probed (minor 4)", async () => {
    const env = makeEnv();
    env.connections = [conn("c1")];
    env.settings = { diagnosticModels: { c1: ["m1"] } };
    env.checkAndRefreshToken = async (_provider, c) => {
      // traffic arrives while this connection waits in the pool
      env.inflight[c.id] = 2;
      env.refreshes.push(c.id);
      return c;
    };
    const result = await runCapacityScan(env.scanDeps());
    expect(result.detected).toBe(0);
    expect(result.skipped).toBe(1);
    expect(env.probes).toEqual([]);
    expect(result.perProvider).toContainEqual({ provider: "glm", reason: "busy (inflight > 0)", count: 1 });
  });

  it("refresh rides the pool: with parallelism 1 each probe follows its own refresh (minor 5)", async () => {
    const env = makeEnv();
    env.connections = [conn("c1"), conn("c2")];
    env.settings = { diagnosticModels: { c1: ["m1"], c2: ["m1"] }, capacityScan: { parallelism: 1 } };
    const events = [];
    const originalRefresh = env.checkAndRefreshToken;
    env.checkAndRefreshToken = async (p, c) => { events.push(`refresh ${c.id}`); return originalRefresh(p, c); };
    const originalProbe = env.probeFn;
    env.probeFn = async (task) => { events.push(`probe ${task.connection.id}`); return originalProbe(task); };
    await runCapacityScan(env.scanDeps());
    expect(events).toEqual(["refresh c1", "probe c1", "refresh c2", "probe c2"]);
  });
});

describe("review minor 9: scan failures are not silent", () => {
  it("warns when the final settings re-read fails and still finishes on the start snapshot", async () => {
    const env = makeEnv();
    env.connections = [conn("c1")];
    env.settings = { diagnosticModels: { c1: ["m1"] } };
    let calls = 0;
    const originalGet = env.getSettings;
    env.getSettings = async () => {
      calls += 1;
      if (calls > 1) throw new Error("db down");
      return originalGet();
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runCapacityScan(env.scanDeps());
      expect(result.detected).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/CAPACITY/), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});
