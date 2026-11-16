import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesQuotaHints } from "../../src/lib/fork/capacity/classifyError.js";
import { handleLiveQuotaError, parseResetsIn } from "../../src/sse/services/quotaCollapse.js";
import { markAccountUnavailable } from "../../src/sse/services/auth.js";

// In-memory settings — quotaCollapse resolves the same "@/lib/localDb" module,
// so its writes land in this map (vi.mock is hoisted above every import).
const db = vi.hoisted(() => ({ settings: {} }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => db.settings,
  updateSettings: async (patch) => { db.settings = { ...db.settings, ...patch }; },
  getProviderConnections: async (query = {}) =>
    (db.settings.providerConnections || []).filter((c) => !query.provider || c.provider === query.provider),
  updateProviderConnection: async (id, patch) => {
    const rows = db.settings.providerConnections || [];
    const row = rows.find((c) => c.id === id);
    if (row) Object.assign(row, patch);
    return row;
  },
  validateApiKey: async () => null,
  getProxyPools: async () => [],
}));

describe("matchesQuotaHints", () => {
  it("matches the scan's quota dialects", () => {
    expect(matchesQuotaHints(`{"error":{"type":"GoUsageLimitError"}}`)).toBe(true);
    expect(matchesQuotaHints("usage limit reached (monthly)")).toBe(true);
  });
  it("does not match generic throttle or unrelated text", () => {
    expect(matchesQuotaHints("rate limit exceeded")).toBe(false);
    expect(matchesQuotaHints("")).toBe(false);
    expect(matchesQuotaHints(undefined)).toBe(false);
  });
});

describe("parseResetsIn", () => {
  it("parses days+hours and hours+minutes into milliseconds", () => {
    expect(parseResetsIn("You've hit your plan limit. Resets in 8d 4h")).toBe((8 * 24 + 4) * 3600000);
    expect(parseResetsIn("quota window resets in 5h 20m")).toBe((5 * 60 + 20) * 60000);
  });
  it("returns null without a resets-in phrase or with no numbers", () => {
    expect(parseResetsIn("GoUsageLimitError")).toBe(null);
    expect(parseResetsIn("resets in soon")).toBe(null);
    expect(parseResetsIn(undefined)).toBe(null);
  });
});

describe("handleLiveQuotaError", () => {
  beforeEach(() => { db.settings = {}; });

  it("collapses a hint-matched error with a parseable reset within 24h, stashing previousBudget", async () => {
    db.settings = { detectedBudgets: { c1: { m1: { budget: 4 } } } };
    const collapsed = await handleLiveQuotaError({ connectionId: "c1", provider: "opencode-go", model: "m1", errorText: "GoUsageLimitError resets in 5h" });
    expect(collapsed).toBe(true);
    const entry = db.settings.detectedBudgets.c1.m1;
    expect(entry).toMatchObject({ budget: 0, quota: true, previousBudget: 4, source: "live" });
    expect(db.settings.quotaRecheck).toEqual([{ connectionId: "c1", provider: "opencode-go", model: "m1", at: expect.any(String) }]);
  });

  it("collapses on resetsAtMs alone (GLM 1308) and enqueues when the reset is within 24h", async () => {
    const at = Date.now() + 5 * 3600000;
    const collapsed = await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m1", errorText: "error 1308", resetsAtMs: at });
    expect(collapsed).toBe(true);
    expect(new Date(db.settings.quotaRecheck[0].at).getTime()).toBeGreaterThanOrEqual(at - 2000);
  });

  it("does not collapse a generic 500 and does not enqueue past-24h or unparseable resets", async () => {
    expect(await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m", errorText: "internal error", resetsAtMs: null })).toBe(false);
    expect(await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m", errorText: "GoUsageLimitError resets in 8d" })).toBe(true);
    expect(db.settings.quotaRecheck).toBeUndefined();
    expect(await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m", errorText: "GoUsageLimitError" })).toBe(true);
    expect(db.settings.quotaRecheck).toBeUndefined();
  });

  it("writes keyless lanes under the provider id and dedupes the queue by connection+model", async () => {
    await handleLiveQuotaError({ connectionId: "opencode", provider: "opencode", model: "big-pickle", errorText: "GoUsageLimitError resets in 2h" });
    expect(db.settings.detectedBudgets.opencode["big-pickle"].budget).toBe(0);
    await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m1", errorText: "error 1308", resetsAtMs: Date.now() + 3600000 });
    await handleLiveQuotaError({ connectionId: "c1", provider: "glm", model: "m1", errorText: "error 1308", resetsAtMs: Date.now() + 7200000 });
    expect(db.settings.quotaRecheck).toHaveLength(2);
    expect(db.settings.quotaRecheck.filter((e) => e.connectionId === "c1")).toHaveLength(1);
  });
});

describe("markAccountUnavailable funnels into the live collapse", () => {
  beforeEach(() => { db.settings = {}; });

  it("a quota error on a real connection collapses it; a plain 500 does not", async () => {
    db.settings = { providerConnections: [{ id: "c1", provider: "opencode-go", isActive: true, data: "{}" }] };
    await markAccountUnavailable("c1", 429, "GoUsageLimitError resets in 2h", "opencode-go", "m1");
    expect(db.settings.detectedBudgets.c1.m1.budget).toBe(0);
    db.settings = { providerConnections: db.settings.providerConnections };
    await markAccountUnavailable("c1", 500, "internal error", "opencode-go", "m1");
    expect(db.settings.detectedBudgets).toBeUndefined();
  });

  it("a keyless lane id still collapses under the provider key (before the early return)", async () => {
    await markAccountUnavailable("opencode", 429, "GoUsageLimitError resets in 2h", "opencode", "big-pickle");
    expect(db.settings.detectedBudgets.opencode["big-pickle"].budget).toBe(0);
  });
});
