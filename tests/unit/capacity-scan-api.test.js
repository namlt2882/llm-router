import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory settings/connections — scan.js resolves the same "@/lib/localDb"
// module, so its persisted running flag is visible to GET through this map.
const db = vi.hoisted(() => ({ settings: {}, connections: [], failUpdates: false }));
const probeState = vi.hoisted(() => ({ slow: false, calls: [] }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) =>
      new Response(JSON.stringify(body), { status: init.status || 200, headers: init.headers }),
  },
}));
vi.mock("@/lib/forkAdminAuth", () => ({
  assertForkAdmin: async (request) => request.headers.get("authorization") === "Bearer secret-token",
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => db.settings,
  updateSettings: async (patch) => { if (db.failUpdates) throw new Error("db down"); db.settings = { ...db.settings, ...patch }; },
  getProviderConnections: async () => db.connections,
  getComboByName: async (name) => db.settings.combos?.[name] || null,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c }));
vi.mock("../../src/lib/fork/capacity/probe.js", () => ({
  dispatchFor: () => async () => ({ ok: true }),
  probeConnectionModel: async (input) => {
    probeState.calls.push(input);
    if (probeState.slow) {
      // Hold the scan open (running stays true) until the test releases it —
      // a scan that never finishes also holds the in-process scan mutex, so
      // the test MUST release before the next one runs.
      await new Promise((resolve) => { probeState.release = resolve; });
    }
    return { status: "ok", budget: 4, requests: 1 };
  },
}));

const { GET, POST } = await import("@/app/api/fork/capacity-scan/route.js");

const req = (method, { token = "secret-token", query = "" } = {}) =>
  new Request(`http://router/api/fork/capacity-scan${query}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });

beforeEach(() => {
  probeState.slow = false;
  probeState.calls = [];
  db.failUpdates = false;
  db.settings = {};
  db.connections = [];
  vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "4");
});

describe("/api/fork/capacity-scan", () => {
  it("401s without a fork admin token", async () => {
    const res = await GET(req("GET", { token: "wrong" }));
    expect(res.status).toBe(401);
    const post = await POST(req("POST", { token: "wrong" }));
    expect(post.status).toBe(401);
  });

  it("GET returns the scan state shape with coverage", async () => {
    db.settings = {
      capacityScan: { enabled: true, intervalHours: 12, lastRunAt: "2026-11-15T00:00:00.000Z", nextRunAt: "2026-11-16T00:00:00.000Z", lastResult: { detected: 2 } },
      diagnosticModels: { glm: ["m1"], "conn-1": ["m2"] },
    };
    db.connections = [{ id: "conn-1", provider: "glm", isActive: true }];
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      running: false,
      enabled: true,
      intervalHours: 12,
      lastRunAt: "2026-11-15T00:00:00.000Z",
      nextRunAt: "2026-11-16T00:00:00.000Z",
      lastResult: { detected: 2 },
      coverage: { providersConfigured: 1, connectionsConfigured: 1 },
    });
    expect(body.summary).toBeUndefined();
  });

  it("?combo= sums effective budgets over leaf members (percent-scaled detected + untested global)", async () => {
    db.settings = {
      combos: { "combo-x": { models: ["glm/glm-4.5-flash", "glm/untested"] } },
      comboStrategies: { "combo-x": { fallbackStrategy: "fanout", fanout: { percent: 80 } } },
      detectedBudgets: { "conn-1": { "glm-4.5-flash": { budget: 5 } } },
    };
    db.connections = [{ id: "conn-1", provider: "glm", isActive: true }];
    const res = await GET(req("GET", { query: "?combo=combo-x" }));
    const body = await res.json();
    // glm-4.5-flash: floor(5 × 0.8) = 4; untested: global 4 → Σ 8 over 2 members
    expect(body.summary).toEqual({ combo: "combo-x", sum: 8, members: 2 });
  });

  it("a keyless member (no connections) counts its provider-level lane: detected, else the global cap", async () => {
    db.settings = {
      combos: { "combo-k": { models: ["opencode/big-pickle", "opencode/untested"] } },
      comboStrategies: { "combo-k": { fallbackStrategy: "fanout" } },
      detectedBudgets: { opencode: { "big-pickle": { budget: 6 } } },
    };
    db.connections = [];
    const body = await (await GET(req("GET", { query: "?combo=combo-k" }))).json();
    // big-pickle: detected 6; untested: global 4 → Σ 10 over 2 members
    expect(body.summary).toEqual({ combo: "combo-k", sum: 10, members: 2 });
  });

  it("a keyless lane's contribution is clamped to the keyless ceiling (unbounded 32 counts 6)", async () => {
    db.settings = {
      combos: { "combo-u": { models: ["opencode/big-pickle"] } },
      comboStrategies: { "combo-u": { fallbackStrategy: "fanout" } },
      detectedBudgets: { opencode: { "big-pickle": { budget: 32, unbounded: true } } },
    };
    db.connections = [];
    const body = await (await GET(req("GET", { query: "?combo=combo-u" }))).json();
    expect(body.summary).toEqual({ combo: "combo-u", sum: 6, members: 1 });
  });

  it("a nested combo member is counted, not summed", async () => {
    db.settings = {
      combos: {
        "combo-x": { models: ["inner-c", "glm/m"] },
        "inner-c": { models: ["glm/m2"] },
      },
      comboStrategies: { "combo-x": { fallbackStrategy: "fanout" } },
    };
    db.connections = [{ id: "conn-1", provider: "glm", isActive: true }];
    const body = await (await GET(req("GET", { query: "?combo=combo-x" }))).json();
    expect(body.summary).toEqual({ combo: "combo-x", sum: 4, members: 1, nested: 1 });
  });

  it("POST starts a scan fire-and-forget; GET then shows running; POST again → 409", async () => {
    db.settings = { capacityScan: { enabled: true }, diagnosticModels: { "conn-1": ["m1"] } };
    db.connections = [{ id: "conn-1", provider: "glm", isActive: true }];
    probeState.slow = true; // hold the probe open so the scan stays running

    const started = await POST(req("POST"));
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ started: true });

    // let the fire-and-forget scan persist its running flag
    for (let i = 0; i < 20 && !db.settings.capacityScan?.running; i++) await new Promise((r) => setTimeout(r, 10));
    const state = await (await GET(req("GET"))).json();
    expect(state.running).toBe(true);

    const again = await POST(req("POST"));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ started: false, running: true });

    // Release the held probe and let the zombie scan finish — it holds the
    // in-process scan mutex, which the next test needs free.
    probeState.slow = false;
    probeState.release?.();
    for (let i = 0; i < 50 && db.settings.capacityScan?.running; i++) await new Promise((r) => setTimeout(r, 10));
    expect(db.settings.capacityScan?.running).toBe(false);
  });

  it("POST with nothing configured still starts and finishes cleanly", async () => {
    db.settings = { capacityScan: { enabled: false } };
    const started = await POST(req("POST"));
    expect(await started.json()).toEqual({ started: true });
    for (let i = 0; i < 50 && db.settings.capacityScan?.running; i++) await new Promise((r) => setTimeout(r, 10));
    expect(db.settings.capacityScan?.running).toBe(false);
    expect(db.settings.capacityScan?.lastResult).toMatchObject({ scanned: 0, detected: 0 });
  });
});

// Review minor 9: a fire-and-forget scan that rejects must not vanish.
describe("/api/fork/capacity-scan minor 9", () => {
  it("warns when the fire-and-forget scan rejects", async () => {
    db.settings = { capacityScan: { enabled: true }, diagnosticModels: { "conn-1": ["m1"] } };
    db.connections = [{ id: "conn-1", provider: "glm", isActive: true }];
    db.failUpdates = true; // the running-persist write throws → the scan rejects
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const started = await POST(req("POST"));
      expect(await started.json()).toEqual({ started: true });
      await new Promise((r) => setTimeout(r, 20)); // let the rejection land
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/CAPACITY/), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});

// Review minor 3 follow-up (found live: the scan with settings maxLevel 4
// still ran the full 32 ramp — the DEFAULT probeFn dropped the field). The
// default path must forward the knob to probeConnectionModel.
describe("/api/fork/capacity-scan knob forwarding", () => {
  it("the default probeFn forwards settings maxLevel to the probe", async () => {
    db.settings = { capacityScan: { enabled: true, maxLevel: 4 }, diagnosticModels: { "conn-1": ["m1"] } };
    db.connections = [{ id: "conn-1", provider: "glm", isActive: true }];
    const started = await POST(req("POST"));
    expect(await started.json()).toEqual({ started: true });
    for (let i = 0; i < 50 && db.settings.capacityScan?.running; i++) await new Promise((r) => setTimeout(r, 10));
    expect(probeState.calls[0]?.maxLevel).toBe(4);
  });
});

describe("POST { provider } — per-provider diagnostic run", () => {
  it("scans only that provider and leaves the daily schedule untouched", async () => {
    db.settings = {
      capacityScan: { enabled: true, lastRunAt: "2026-01-01T00:00:00.000Z", nextRunAt: "2026-01-02T00:00:00.000Z" },
      diagnosticModels: { glm: ["m1"], oc: ["m2"] },
    };
    db.connections = [
      { id: "c-glm", provider: "glm", isActive: true },
      { id: "c-oc", provider: "oc", isActive: true },
    ];
    const res = await POST(new Request("http://router/api/fork/capacity-scan", {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
      body: JSON.stringify({ provider: "glm" }),
    }));
    expect(res.status).toBe(200);
    for (let i = 0; i < 100 && probeState.calls.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(probeState.calls.map((c) => c.connection.id)).toEqual(["c-glm"]);
    for (let i = 0; i < 100 && db.settings.capacityScan?.running; i++) await new Promise((r) => setTimeout(r, 10));
    expect(db.settings.capacityScan.running).toBe(false);
    expect(db.settings.capacityScan.lastResult.provider).toBe("glm");
    // the daily schedule belongs to the full scan — untouched
    expect(db.settings.capacityScan.lastRunAt).toBe("2026-01-01T00:00:00.000Z");
    expect(db.settings.capacityScan.nextRunAt).toBe("2026-01-02T00:00:00.000Z");
    expect(db.settings.detectedBudgets["c-glm"].m1.budget).toBe(4);
    expect(db.settings.detectedBudgets["c-oc"]).toBeUndefined();
  });

  it("409s while ANY scan (also a full one) is running — one scan at a time", async () => {
    db.settings = { diagnosticModels: { glm: ["m1"] } };
    db.connections = [{ id: "c-glm", provider: "glm", isActive: true }];
    probeState.slow = true;
    const first = await POST(req("POST"));
    expect(first.status).toBe(200);
    for (let i = 0; i < 100 && !db.settings.capacityScan?.running; i++) await new Promise((r) => setTimeout(r, 10));
    const scoped = await POST(new Request("http://router/api/fork/capacity-scan", {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
      body: JSON.stringify({ provider: "glm" }),
    }));
    expect(scoped.status).toBe(409);
    probeState.slow = false;
    probeState.release?.();
    for (let i = 0; i < 100 && db.settings.capacityScan?.running; i++) await new Promise((r) => setTimeout(r, 10));
    expect(db.settings.capacityScan.running).toBe(false);
  });
});
