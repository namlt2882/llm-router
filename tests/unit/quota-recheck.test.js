import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ settings: {} }));
const probe = vi.hoisted(() => ({ results: [], inputs: [] }));
const cleared = vi.hoisted(() => ({ calls: [] }));

vi.mock("@/lib/localDb", () => ({
  // Like the real getSettings (parseJson → mergeWithDefaults), every call
  // returns a FRESH object — in-place mutations of it are invisible to the
  // store and can only be persisted through updateSettings' patch. This
  // shape is deliberate: the restore-on-probe contract must be proven via
  // the patch, not via a shared reference (the fixture that let C1 pass
  // vacuously returned db.settings itself).
  getSettings: async () => JSON.parse(JSON.stringify(db.settings)),
  updateSettings: async (patch) => { db.settings = { ...db.settings, ...patch }; },
  getProviderConnections: async () => db.settings.providerConnections || [],
}));
// Stub registry: glm declares an openai transport (default dispatch path);
// the custom node id matches no entry at all.
vi.mock("open-sse/providers/registry/index.js", () => ({
  default: [
    { id: "glm", transports: [{ format: "openai", baseUrl: "https://glm.example/v4/chat/completions" }] },
    { id: "nogpt", transports: [{ format: "claude", baseUrl: "https://x/api/messages" }] },
  ],
}));
// Neither glm nor a custom node id carries a specialized executor (the real
// executors index pulls in executor modules that read registry entries at
// import time, so it cannot load under the stub registry above).
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => null,
  hasSpecializedExecutor: () => false,
}));
vi.mock("../../src/lib/fork/capacity/probe.js", async (importOriginal) => {
  const actual = await importOriginal();
  const realProbe = actual.probeConnectionModel;
  return {
    ...actual,
    // Recorder with a realMode passthrough: most tests assert on the verdict
    // mapping and hand probe.results to the recorder; the dispatch-selection
    // tests set realMode so the REAL probeConnectionModel + REAL dispatchFor
    // run against a stubbed fetch — which builder dispatchFor consulted is
    // an internal binding, not observable; the wire URL it hits is.
    probeConnectionModel: async (input) => {
      probe.inputs.push(input);
      if (probe.realMode) return realProbe(input);
      return { ...probe.results.shift(), input };
    },
  };
});
vi.mock("../../src/sse/services/auth.js", () => ({
  clearAccountError: async (...args) => { cleared.calls.push(args); },
}));

const { processDueQuotaRecheck, ensureQuotaRecheckScheduler, resetQuotaRecheckScheduler } =
  await import("../../src/lib/fork/capacity/quotaRecheck.js");

const NOW = Date.parse("2026-11-16T10:00:00.000Z");
const entry = (over = {}) => ({ connectionId: "c1", provider: "glm", model: "m1", at: new Date(NOW - 60000).toISOString(), ...over });
const run = (over = {}) => processDueQuotaRecheck({ now: NOW, probeFn: async () => probe.results.shift(), ...over });
const conn = () => [{ id: "c1", provider: "glm", isActive: true, data: "{}" }];

describe("processDueQuotaRecheck", () => {
  beforeEach(() => { db.settings = {}; probe.results = []; probe.inputs = []; probe.realMode = false; cleared.calls = []; });

  it("restores previousBudget, clears the account error and drops the entry on probe ok", async () => {
    db.settings = { quotaRecheck: [entry()], detectedBudgets: { c1: { m1: { budget: 0, quota: true, previousBudget: 4 } } }, providerConnections: conn() };
    probe.results = [{ status: "ok", budget: 1, requests: 1 }];
    const out = await run();
    expect(out).toEqual({ probed: 1, restored: 1, rescheduled: 0, dropped: 0 });
    expect(db.settings.detectedBudgets.c1.m1.budget).toBe(4);
    expect(db.settings.detectedBudgets.c1.m1.quota).toBeUndefined();
    expect(db.settings.quotaRecheck).toEqual([]);
    expect(cleared.calls[0][0]).toBe("c1");
  });

  it("deletes the detectedBudgets key on success when there is no previousBudget", async () => {
    db.settings = { quotaRecheck: [entry()], detectedBudgets: { c1: { m1: { budget: 0, quota: true } } }, providerConnections: conn() };
    probe.results = [{ status: "ok", budget: 1, requests: 1 }];
    await run();
    expect(db.settings.detectedBudgets.c1.m1).toBeUndefined();
    expect(db.settings.quotaRecheck).toEqual([]);
  });

  it("reschedules on quota-again within 24h and drops beyond it or unparseable", async () => {
    db.settings = { quotaRecheck: [entry()], providerConnections: conn() };
    probe.results = [{ status: "quota", reason: "GoUsageLimitError resets in 3h", requests: 1 }];
    let out = await run();
    expect(out.rescheduled).toBe(1);
    expect(new Date(db.settings.quotaRecheck[0].at).getTime()).toBe(NOW + 3 * 3600000);
    db.settings.quotaRecheck = [entry()];
    probe.results = [{ status: "quota", reason: "GoUsageLimitError resets in 8d", requests: 1 }];
    out = await run();
    expect(out.dropped).toBe(1);
    expect(db.settings.quotaRecheck).toEqual([]);
  });

  it("keeps the entry on transient probe outcomes and retries later", async () => {
    db.settings = { quotaRecheck: [entry()], providerConnections: conn() };
    probe.results = [{ status: "unreachable", reason: "timeout", requests: 1 }];
    const out = await run();
    expect(out.probed).toBe(1);
    expect(db.settings.quotaRecheck).toHaveLength(1);
  });

  // Wire-level dispatch selection: realMode lets the REAL probeConnectionModel
  // run, so the probe travels through the REAL dispatchFor → dispatch chain
  // and the stubbed fetch records the URL it chose. Which builder object was
  // consulted is an internal module binding — unobservable from outside.
  const wireFetch = (calls) => async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
  };

  it("probes a registry lane through its openai transport on the default path", async () => {
    probe.realMode = true;
    db.settings = { quotaRecheck: [entry()], providerConnections: conn() };
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = wireFetch(calls);
    try {
      // No probeFn: the production default path. It must reach the lane the
      // way scan.js does — through dispatchFor(provider, connection) — or
      // executor-backed providers (the GoUsageLimitError lanes this feature
      // exists for) are probed with the generic transport and can never be
      // restored.
      const out = await processDueQuotaRecheck({ now: NOW });
      expect(out.restored).toBe(1);
      expect(probe.inputs).toHaveLength(1);
      expect(calls).toEqual(["https://glm.example/v4/chat/completions"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a custom-node lane probes the wire at its own baseUrl (not dropped as unsupported)", async () => {
    probe.realMode = true;
    const nodeProvider = "openai-compatible-chat-1f4a7e22-9000-4a10-b001-fanout000001";
    db.settings = {
      quotaRecheck: [entry({ connectionId: "c9", provider: nodeProvider })],
      providerConnections: [{ id: "c9", provider: nodeProvider, isActive: true, data: "{}", providerSpecificData: { baseUrl: "http://localhost:9101/v1", apiType: "chat" } }],
    };
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = wireFetch(calls);
    try {
      const out = await processDueQuotaRecheck({ now: NOW });
      // Without this the node lane resolves no executor and no registry
      // transport, is dropped terminal-unsupported, and the queue empties
      // with zero wire probes — observed live 2026-11-17.
      expect(out.dropped).toBe(0);
      expect(out.restored).toBe(1);
      expect(calls).toEqual(["http://localhost:9101/v1/chat/completions"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("drops terminal non-quota verdicts (auth/config/balance/unsupported)", async () => {
    db.settings = { quotaRecheck: [entry()], providerConnections: conn() };
    probe.results = [{ status: "auth", reason: "401", requests: 1 }];
    expect((await run()).dropped).toBe(1);
    expect(db.settings.quotaRecheck).toEqual([]);
  });

  it("writes nothing when the tick changed nothing (only-future queue)", async () => {
    db.settings = { quotaRecheck: [entry({ at: new Date(NOW + 3600000).toISOString() })], providerConnections: conn() };
    const writes = [];
    const out = await processDueQuotaRecheck({
      now: NOW,
      probeFn: async () => { throw new Error("nothing due — must not probe"); },
      updateSettingsFn: async (patch) => writes.push(patch),
    });
    expect(out).toEqual({ probed: 0, restored: 0, rescheduled: 0, dropped: 0 });
    // Review minor M4: an unchanged queue must not churn the settings row
    // every 60s (~1,380 identical writes across a 23h pending entry).
    expect(writes).toEqual([]);
  });

  it("reschedules a quota-again verdict carrying an increasing reschedule count", async () => {
    db.settings = { quotaRecheck: [entry({ reschedules: 7 })], providerConnections: conn() };
    probe.results = [{ status: "quota", reason: "GoUsageLimitError resets in 3h", requests: 1 }];
    const out = await run();
    expect(out.rescheduled).toBe(1);
    expect(db.settings.quotaRecheck[0].reschedules).toBe(8);
  });

  it("drops a lane after MAX consecutive quota-reschedules with no restore between them", async () => {
    db.settings = { quotaRecheck: [entry({ reschedules: 8 })], providerConnections: conn() };
    probe.results = [{ status: "quota", reason: "GoUsageLimitError resets in 5m", requests: 1 }];
    // Review minor M5: a rolling-window quota whose resets are always short
    // would reschedule forever (at keeps moving, the 24h staleness guard
    // never fires) — the cap hands the lane back to the daily scan.
    const out = await run();
    expect(out.dropped).toBe(1);
    expect(out.rescheduled).toBe(0);
    expect(db.settings.quotaRecheck).toEqual([]);
  });

  it("drops a stale entry (>24h past its time) and an entry whose connection vanished", async () => {
    db.settings = { quotaRecheck: [entry({ at: new Date(NOW - 25 * 3600000).toISOString() }), entry({ connectionId: "gone" })], providerConnections: conn() };
    const out = await run({ probeFn: async () => { throw new Error("must not probe stale/missing"); } });
    expect(out.dropped).toBe(2);
    expect(db.settings.quotaRecheck).toEqual([]);
  });

  it("probes at most maxPerTick entries per run and only due ones", async () => {
    db.settings = {
      quotaRecheck: [
        entry({ connectionId: "c1" }), entry({ connectionId: "c2" }), entry({ connectionId: "c3" }),
        entry({ connectionId: "c4" }), entry({ connectionId: "c5" }), entry({ connectionId: "c6" }),
        entry({ connectionId: "later", at: new Date(NOW + 3600000).toISOString() }),
      ],
      providerConnections: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `c${i}`, provider: "glm", isActive: true, data: "{}" })),
    };
    const out = await run({ probeFn: async () => ({ status: "ok", budget: 1, requests: 1 }) });
    expect(out.probed).toBe(5);
    expect(db.settings.quotaRecheck.map((e) => e.connectionId)).toEqual(["c6", "later"]);
  });
});

describe("ensureQuotaRecheckScheduler", () => {
  it("is idempotent — the second call returns the same handle", () => {
    const a = ensureQuotaRecheckScheduler({ getSettingsFn: async () => ({}) });
    const b = ensureQuotaRecheckScheduler();
    expect(b).toBe(a);
    resetQuotaRecheckScheduler();
  });
});
