import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ settings: {}, connections: [], rows: [], active: 0, deleted: [], freeProviders: {}, providerModels: {} }));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => state.settings,
  getProviderConnections: async () => state.connections,
}));
vi.mock("../../src/lib/db/repos/usageRepo.js", () => ({
  getActiveRequests: async () => ({ activeRequests: [{ count: state.active }], recentRequests: [], errorProvider: "" }),
  recordConcurrencySample: async (inflight, totalBudget) => { state.rows.push({ inflight, totalBudget }); },
  pruneConcurrencySamples: async (_db, cutoffIso) => { state.deleted.push(cutoffIso); },
}));
// The registry carries THREE free noAuth providers (opencode, devin-cli,
// mimo-free); pinning the lane rule needs a controlled set, not the live one.
vi.mock("../../src/shared/constants/providers.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, FREE_PROVIDERS: state.freeProviders };
});
// Controlled model list: coverage ("does this lane measure every model its
// provider serves?") must not drift with the live registry.
vi.mock("../../open-sse/config/providerModels.js", () => ({
  PROVIDER_MODELS: state.providerModels,
  getProviderModels: (p) => state.providerModels[p] || [],
}));

const { systemConcurrencyBudget, sampleOnce, ensureConcurrencyScheduler, resetConcurrencyScheduler } =
  await import("../../src/lib/usage/concurrencySampler.js");

describe("systemConcurrencyBudget", () => {
  beforeEach(() => {
    state.settings = {};
    state.connections = [];
    // mutate in place — the mock factories captured these objects' references
    for (const k of Object.keys(state.freeProviders)) delete state.freeProviders[k];
    for (const k of Object.keys(state.providerModels)) delete state.providerModels[k];
    state.providerModels.glm = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];
  });
  const global = 4;

  it("counts each connection once at its max detected budget, else the global", async () => {
    state.settings = { detectedBudgets: { c1: { a: { budget: 10 }, b: { budget: 6 } }, c2: {} } };
    state.connections = [
      { id: "c1", provider: "glm", isActive: true },
      { id: "c2", provider: "glm", isActive: true },
      { id: "c3", provider: "glm", isActive: false }, // inactive: not counted
    ];
    expect(await systemConcurrencyBudget({ settings: state.settings, connections: state.connections, globalLimit: global })).toBe(10 + global);
  });

  it("lifts a partially measured, uncollapsed lane to the global (unmeasured models admit at global)", async () => {
    // Review minor M6 / spec "max effective budget across models": one
    // measured model at 2, two unmeasured models admission serves at the
    // global 4 — the lane's effective ceiling is 4, not 2.
    state.settings = { detectedBudgets: { c1: { m1: { budget: 2 } } } };
    state.connections = [{ id: "c1", provider: "glm", isActive: true }];
    expect(await systemConcurrencyBudget({ settings: state.settings, connections: state.connections, globalLimit: global })).toBe(global);
  });

  it("counts a fully measured lane at its measured max alone", async () => {
    state.settings = { detectedBudgets: { c1: { m1: { budget: 2 }, m2: { budget: 3 }, m3: { budget: 1 } } } };
    state.connections = [{ id: "c1", provider: "glm", isActive: true }];
    expect(await systemConcurrencyBudget({ settings: state.settings, connections: state.connections, globalLimit: global })).toBe(3);
  });

  it("never lifts a collapsed lane to the global — the collapse must stay visible in the chart", async () => {
    // The spec's max-effective phrasing would raise a collapsed lane (other
    // models unmeasured → global) and hide the very squeeze this chart
    // exists to show. Deliberate deviation: a lane with a quota collapse
    // counts its measured max (0 here), whatever the unmeasured model list.
    state.settings = { detectedBudgets: { c1: { m1: { budget: 0, quota: true } } } };
    state.connections = [{ id: "c1", provider: "glm", isActive: true }];
    expect(await systemConcurrencyBudget({ settings: state.settings, connections: state.connections, globalLimit: global })).toBe(0);
  });

  it("a dynamic-model custom node keeps the measured-max signal", async () => {
    // openai-compatible-* serve dynamic model lists — no coverage notion, so
    // the measured max (including a collapse's 0) stays the count.
    state.settings = { detectedBudgets: { c1: { m: { budget: 0, quota: true } } } };
    state.connections = [{ id: "c1", provider: "openai-compatible-chat-x", isActive: true }];
    expect(await systemConcurrencyBudget({ settings: state.settings, connections: state.connections, globalLimit: global })).toBe(0);
  });

  it("counts one keyless lane per unconnected noAuth provider at the keyless ceiling", async () => {
    state.settings = { detectedBudgets: { opencode: { "big-pickle": { budget: 32, unbounded: true } } } };
    state.connections = [];
    const real = await vi.importActual("../../src/shared/constants/providers.js");
    expect(real.FREE_PROVIDERS.opencode?.noAuth).toBe(true); // registry premise — fails loudly if it drifts
    Object.assign(state.freeProviders, { opencode: { id: "opencode", noAuth: true } });
    expect(await systemConcurrencyBudget({ settings: state.settings, connections: [], globalLimit: global })).toBe(6); // keyless ceiling
  });
});

describe("sampleOnce", () => {
  beforeEach(() => {
    state.rows = []; state.active = 0; state.deleted = []; state.settings = {}; state.connections = [];
    for (const k of Object.keys(state.freeProviders)) delete state.freeProviders[k];
  });
  it("writes one row with Σ counts and the system budget", async () => {
    state.active = 3;
    state.settings = { detectedBudgets: {} };
    state.connections = [{ id: "c1", provider: "glm", isActive: true }];
    await sampleOnce({ now: new Date("2026-11-16T10:00:30.000Z"), globalLimit: 4 });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].inflight).toBe(3);
    expect(state.rows[0].totalBudget).toBe("4");
  });
  it("prunes hourly (minute 0) and not otherwise", async () => {
    await sampleOnce({ now: new Date("2026-11-16T10:00:00.000Z") });
    expect(state.deleted).toHaveLength(1);
    await sampleOnce({ now: new Date("2026-11-16T10:00:30.000Z") });
    expect(state.deleted).toHaveLength(1);
  });
});

describe("ensureConcurrencyScheduler", () => {
  it("is idempotent", () => {
    const a = ensureConcurrencyScheduler({});
    expect(ensureConcurrencyScheduler()).toBe(a);
    resetConcurrencyScheduler();
  });
});
