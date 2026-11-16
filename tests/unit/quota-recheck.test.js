import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ settings: {} }));
const probe = vi.hoisted(() => ({ results: [] }));
const cleared = vi.hoisted(() => ({ calls: [] }));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => db.settings,
  updateSettings: async (patch) => { db.settings = { ...db.settings, ...patch }; },
  getProviderConnections: async () => db.settings.providerConnections || [],
}));
vi.mock("../../src/lib/fork/capacity/probe.js", () => ({
  probeConnectionModel: async (input) => ({ ...probe.results.shift(), input }),
}));
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
  beforeEach(() => { db.settings = {}; probe.results = []; cleared.calls = []; });

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

  it("drops terminal non-quota verdicts (auth/config/balance/unsupported)", async () => {
    db.settings = { quotaRecheck: [entry()], providerConnections: conn() };
    probe.results = [{ status: "auth", reason: "401", requests: 1 }];
    expect((await run()).dropped).toBe(1);
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
