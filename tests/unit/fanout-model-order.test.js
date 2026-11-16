import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ connections: {}, settings: {}, locked: new Set() }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async ({ provider }) => h.connections[provider] || [],
  getSettings: async () => h.settings,
}));
vi.mock("open-sse/services/accountFallback.js", () => ({
  isModelLockActive: (c, model) => h.locked.has(`${c.id}:${model}`),
}));

const inflight = await import("../../src/sse/services/accountInflight.js");
const { orderModelsByHeadroom, __resetFanoutModels } = await import("../../src/sse/services/fanoutModels.js");
const { setStickyComboModel, clearStickyComboSession } = await import("../../open-sse/services/systemoneRouter.js");

const info = async (m) => {
  const i = m.indexOf("/");
  return { provider: m.slice(0, i), model: m.slice(i + 1) };
};
const FANOUT = { enabled: true, budgets: {}, percent: 100 };
const conn = (id, provider) => ({ id, provider, isActive: true });
const fill = (id, n) => { for (let i = 0; i < n; i++) inflight.tryAcquireAccountSlot(id, 99); };
const order = (models, extra = {}) =>
  orderModelsByHeadroom({ models, comboName: "wb", sessionId: null, fanoutCtx: FANOUT, getModelInfo: info, ...extra });

beforeEach(() => {
  inflight.__resetAccountInflight();
  __resetFanoutModels();
  clearStickyComboSession("wb");
  h.locked = new Set();
  h.connections = { glm: [conn("g1", "glm")], openai: [conn("o1", "openai")] };
  h.settings = { detectedBudgets: { g1: { "a": { budget: 4 } }, o1: { "b": { budget: 4 } } } };
});

describe("fanout model ordering", () => {
  it("puts the emptier lane first", async () => {
    fill("g1", 3); // 3/4 used, o1 empty
    const { models } = await order(["glm/a", "openai/b"]);
    expect(models).toEqual(["openai/b", "glm/a"]);
  });

  it("keeps combo order on a tie", async () => {
    const { models } = await order(["glm/a", "openai/b"]);
    expect(models).toEqual(["glm/a", "openai/b"]);
  });

  it("spreads a concurrent burst: a pending pick counts against its lane", async () => {
    const first = await order(["glm/a", "openai/b"]);
    const second = await order(["glm/a", "openai/b"]);
    expect(first.models[0]).toBe("glm/a");
    expect(second.models[0]).toBe("openai/b");
    first.release();
    second.release();
    const third = await order(["glm/a", "openai/b"]);
    expect(third.models[0]).toBe("glm/a"); // pending released → tie → least recently picked / combo order
  });

  it("release is idempotent", async () => {
    const first = await order(["glm/a", "openai/b"]);
    first.release();
    first.release();
    const second = await order(["glm/a", "openai/b"]);
    expect(second.models[0]).toBe("glm/a");
  });

  it("sorts a full lane and a lane with no usable account to the back, never dropping a model", async () => {
    fill("g1", 4);
    h.connections.nokey = [];
    const { models } = await order(["glm/a", "nokey/z", "openai/b"]);
    expect(models[0]).toBe("openai/b");
    expect([...models].sort()).toEqual(["glm/a", "nokey/z", "openai/b"]);
  });

  it("treats a model-locked account as unavailable", async () => {
    h.locked.add("g1:a");
    const { models } = await order(["glm/a", "openai/b"]);
    expect(models[0]).toBe("openai/b");
  });

  it("counts models that share one keyless lane as one lane", async () => {
    h.settings = { keylessMaxInflight: 2 };
    inflight.tryAcquireAccountSlot("opencode", 2);
    const { models } = await order(["opencode/x", "opencode/y", "openai/b"]);
    // opencode lane is 1/2 used (ratio .5), openai empty (ratio 1)
    expect(models[0]).toBe("openai/b");
    expect(models.slice(1)).toEqual(["opencode/x", "opencode/y"]);
  });

  it("a session's last model stays first while its lane has room", async () => {
    setStickyComboModel("wb", "s1", "glm/a");
    fill("g1", 1);
    const { models } = await order(["glm/a", "openai/b"], { sessionId: "s1" });
    expect(models[0]).toBe("glm/a");
  });

  it("a session migrates once when its lane is full", async () => {
    setStickyComboModel("wb", "s1", "glm/a");
    fill("g1", 4);
    const { models } = await order(["glm/a", "openai/b"], { sessionId: "s1" });
    expect(models[0]).toBe("openai/b");
  });

  it("uses each account's own budget: ratio, not absolute count", async () => {
    h.settings = { detectedBudgets: { g1: { a: { budget: 2 } }, o1: { b: { budget: 8 } } } };
    fill("g1", 1); // 1/2 used
    fill("o1", 3); // 3/8 used → emptier by ratio
    const { models } = await order(["glm/a", "openai/b"]);
    expect(models[0]).toBe("openai/b");
  });

  it("an unknown model (e.g. nested combo) keeps its slot as a free lane", async () => {
    const getModelInfo = async (m) => (m === "sub" ? null : info(m));
    fill("g1", 2);
    const { models } = await order(["glm/a", "sub"], { getModelInfo });
    expect(models[0]).toBe("sub");
  });
});
