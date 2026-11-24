import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [{ id: "c1", name: "sys-combo", models: ["openai/model-a", "openai/model-b"] }],
  settings: {},
  allow: null,
}));
const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleSystemoneCore: vi.fn(),
  // `false`: a member's account failure ends THAT member — the combo (not the
  // account loop) decides to advance to the next member. `true` would retry the
  // same member with a second account and the [model-a, model-b] assertion
  // below could never hold.
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  getAllowSets: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => fx.settings,
  getCombos: async () => fx.combos,
  getProviderNodes: async () => [],
  getProviderConnections: async () => [],
  getModelAliases: async () => ({}),
  getComboByName: async (n) => fx.combos.find((c) => c.name === n) || null,
  getCustomModels: async () => [],
  getProviderConnectionById: async () => null,
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));
// Restricted-key arm: the context comes from the fixture, but `enforceKeyAccess`
// itself is the REAL function — a permissive mock makes the 403 case vacuous.
// Its only dependency this needs stubbed is `getCombos` (already mocked above);
// `getModelInfo` is resolved from the `@/sse/services/model.js` mock below.
vi.mock("@/sse/services/keyAccess.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, getKeyAccessContext: async () => (fx.allow ? { allow: fx.allow, keyName: "sk-media", _sets: null } : null) };
});
// `importOriginal` keeps the REAL `getComboModels` so the §3d parity test below
// compares the two lookups for real; only `getModelInfo` (which needs the db) and
// `getComboModels`'s db read are stubbed. Do NOT hand-write the whole module here —
// a hand-written `getComboModels` would make the parity test assert a mock.
vi.mock("@/sse/services/model.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, getModelInfo: async (m) => { const i = m.indexOf("/"); return i > 0 ? { provider: m.slice(0, i), model: m.slice(i + 1) } : { provider: null, model: m }; } };
});
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn() }));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: mocks.handleSystemoneCore, resolveSystemoneMode: () => "native" }));
// `parsePriority` and `resolveSessionIdentity` are NOT mocked: both are pure and
// read real headers, which is exactly the behaviour the fanout case asserts
// (`x-session-id` → "s2", no priority header → "background"). Mocking them would
// make that assertion a tautology, and a mock returning a constant would hide a
// real wiring bug. Measured: `parsePriority` (accountInflight.js:105) has zero
// imports, and `resolveSessionIdentity` (sessionManager.js:212) needs only
// `crypto` + `runtimeConfig` — both load in a bare vitest process.

const { handleSystemone } = await import("../../src/sse/handlers/systemone.js");
const post = (model, headers = {}) => new Request("http://localhost/v1/systemone", {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model, state: "s", questions: { q: { type: "noul", instructions: "i" } } }),
});
const valid = () => ({ success: true, usage: { prompt_tokens: 1, completion_tokens: 1 },
  response: new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.6 } } }), { status: 200, headers: { "content-type": "application/json" } }) });

beforeEach(() => {
  fx.settings = { requireApiKey: false, comboStrategies: { "sys-combo": { fallbackStrategy: "fallback" } } };
  fx.allow = null;
  mocks.getProviderCredentials.mockReset().mockResolvedValue({ connectionId: "acct", connectionName: "A", apiKey: "k", providerSpecificData: {} });
  mocks.handleSystemoneCore.mockReset();
});

describe("systemone combos", () => {
  it("commits the first member whose answers validate, after a shim failure", async () => {
    mocks.handleSystemoneCore
      .mockResolvedValueOnce({ success: false, status: 502, error: "systemone-shim: member openai/model-a prose", response: new Response("{}", { status: 502 }) })
      .mockResolvedValueOnce(valid());
    const res = await handleSystemone(post("sys-combo"));
    expect(res.status).toBe(200);
    expect((await res.json()).answers).toEqual({ q: { type: "noul", noul: 0.6 } });
    expect(mocks.handleSystemoneCore.mock.calls.map((c) => c[0].modelInfo.model)).toEqual(["model-a", "model-b"]);
  });

  it("rejects a member that returns 200 with answers that do not validate (never a partial answer)", async () => {
    // Task 6's tail decides this: the seat is not committed, `lastStatus = 502`,
    // and with nothing left the loop ends on `new Response({error:{message}})`
    // (combo.js:640-646). Measured 2026-11-24: BEFORE Task 9 this case is a 400
    // "Invalid model format" (a combo name never reaches the loop at all), so
    // the 502 is red until the combo branch exists — it is not a Task-6 no-op.
    mocks.handleSystemoneCore
      .mockResolvedValueOnce({ success: true,
        response: new Response(JSON.stringify({ answers: { q: { noul: "high" } } }), { status: 200, headers: { "content-type": "application/json" } }) })
      .mockResolvedValueOnce({ success: true,
        response: new Response(JSON.stringify({ answers: {} }), { status: 200, headers: { "content-type": "application/json" } }) });
    const res = await handleSystemone(post("sys-combo"));
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toBe("unusable member response");
  });

  it.each(["smart", "fusion", "nonsense"])("refuses strategy %s with a 400 that names it", async (s) => {
    // Measured 2026-11-24: this is a 400/400 pass on status BEFORE the change —
    // but for the wrong reason ("Invalid model format", because a combo name has
    // no provider). The message assertion is what actually fails (measured:
    // expected 'Invalid model format' to match /systemone combos/), and it is
    // the one that proves the whitelist ran. Do not relax it to a bare status.
    fx.settings.comboStrategies["sys-combo"] = { fallbackStrategy: s };
    const res = await handleSystemone(post("sys-combo"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/systemone combos/);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("gates a restricted key on the combo name, not on a synthesized provider/model", async () => {
    fx.allow = ["sys-combo"];
    expect((await handleSystemone(post("sys-combo"))).status).not.toBe(403);
    fx.allow = ["openai/model-a"];                       // a member, not the combo name
    expect((await handleSystemone(post("sys-combo"))).status).toBe(403);
  });

  it("threads fanout and the client session into the member credential lookup", async () => {
    // `x-session-id` is the key `resolveSessionIdentity` reads
    // (sessionManager.js:95). Assert on it: a handler that never normalizes the
    // Headers instance would leave `sessionId` null and this case would pass for
    // the wrong reason.
    fx.settings.comboStrategies["sys-combo"] = { fallbackStrategy: "fanout", fanout: { budgets: { acct: 2 } } };
    mocks.handleSystemoneCore.mockResolvedValue(valid());
    await handleSystemone(post("sys-combo", { "x-session-id": "s2" }));
    const opts = mocks.getProviderCredentials.mock.calls[0][3];
    expect(opts).toMatchObject({ fanout: { enabled: true, budgets: { acct: 2 }, percent: 100 }, sessionId: "s2", priority: "background", wait: true });
  });

  // Spec §3d: the two combo lookups must answer identically for the same input,
  // so a handler may pick either. Both are REAL — `getComboModels` comes through
  // `importOriginal` above and reads the mocked `getComboByName`, so this is a
  // parity assertion, not a mock asserting on itself.
  it("both combo lookups agree (spec §3d)", async () => {
    const { getComboModelsFromData } = await import("../../open-sse/services/combo.js");
    const { getComboModels } = await import("../../src/sse/services/model.js");
    for (const name of ["sys-combo", "not-a-combo", "a/b"]) {
      expect(await getComboModels(name)).toEqual(getComboModelsFromData(name, fx.combos));
    }
    expect(getComboModelsFromData("sys-combo", fx.combos)).toEqual(["openai/model-a", "openai/model-b"]);
  });

});
