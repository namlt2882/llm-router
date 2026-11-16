import { describe, expect, it } from "vitest";
import { providerDetectedRows } from "../../src/app/(dashboard)/dashboard/providers/[id]/provider-detected.js";

// Per-provider measured values on the provider card: rows collected from the
// provider-keyed entry and every connection of this provider, sorted
// connection-first then model, each carrying when it was detected.
describe("providerDetectedRows", () => {
  const connections = [
    { id: "c-1", provider: "glm", name: "Nam" },
    { id: "c-2", provider: "glm", name: "Key 2" },
    { id: "c-x", provider: "oc", name: "Other" },
  ];

  it("collects ONLY per-key (connection) entries — no provider aggregate", () => {
    // Steve's ruling: two keys can have different subscriptions, so the
    // measured capacity is per key. The scan never writes a provider-keyed
    // detectedBudgets entry and nothing reads one — the card must not
    // surface an aggregate row that no budget ever comes from.
    const detectedBudgets = {
      glm: { "glm-5.3-flash": { budget: 5, detectedAt: "2026-11-16T03:32:03.984Z" } },
      "c-1": { "glm-5.3-flash": { budget: 4, detectedAt: "2026-11-16T04:00:00.000Z" } },
      "c-2": { "glm-5.3-flash": { budget: 8, detectedAt: "2026-11-16T04:01:00.000Z" } },
      "c-x": { "m": { budget: 9, detectedAt: "2026-11-16T04:00:00.000Z" } },
    };
    const rows = providerDetectedRows({ providerId: "glm", connections, detectedBudgets });
    expect(rows.map((r) => [r.connId, r.connName, r.model, r.budget])).toEqual([
      ["c-2", "Key 2", "glm-5.3-flash", 8],
      ["c-1", "Nam", "glm-5.3-flash", 4],
    ]);
    expect(rows[0].detectedAt).toBe("2026-11-16T04:01:00.000Z");
  });

  it("sorts by connection name then model", () => {
    const detectedBudgets = {
      "c-2": { "b-model": { budget: 2, detectedAt: "x" }, "a-model": { budget: 3, detectedAt: "x" } },
      "c-1": { "m": { budget: 4, detectedAt: "x" } },
      glm: { "m": { budget: 5, detectedAt: "x" } },
    };
    const rows = providerDetectedRows({ providerId: "glm", connections, detectedBudgets });
    expect(rows.map((r) => `${r.connName}/${r.model}`)).toEqual([
      "Key 2/a-model",
      "Key 2/b-model",
      "Nam/m",
    ]);
    // connections alphabetical by name, models alphabetical within a
    // connection; the provider-keyed entry ("glm") produces NO row
  });

  it("returns [] when nothing was detected for this provider", () => {
    expect(providerDetectedRows({ providerId: "glm", connections, detectedBudgets: {} })).toEqual([]);
    expect(providerDetectedRows({ providerId: "glm", connections, detectedBudgets: null })).toEqual([]);
    // budgets of other providers do not leak in
    expect(providerDetectedRows({ providerId: "glm", connections, detectedBudgets: { "c-x": { m: { budget: 1, detectedAt: "x" } } } })).toEqual([]);
  });

  it("ignores connection ids that belong to no current connection of this provider", () => {
    // e.g. a deleted connection's stale entry must not render
    const detectedBudgets = { "c-deleted": { m: { budget: 1, detectedAt: "x" } } };
    expect(providerDetectedRows({ providerId: "glm", connections, detectedBudgets })).toEqual([]);
  });

  it("a keyless provider (no connections) shows its provider-keyed measurement as one whole-provider row", () => {
    const detectedBudgets = { oc: { "big-pickle": { budget: 6, detectedAt: "2026-11-16T05:00:00.000Z" } } };
    const rows = providerDetectedRows({ providerId: "oc", connections: [], detectedBudgets, keyless: true });
    expect(rows.map((r) => [r.connId, r.connName, r.model, r.budget])).toEqual([
      ["oc", "(toàn provider)", "big-pickle", 6],
    ]);
  });

  it("a keyless provider that ALSO has connections stays per-key (no provider aggregate row)", () => {
    const detectedBudgets = {
      oc: { m: { budget: 6, detectedAt: "x" } },
      "c-oc": { m: { budget: 2, detectedAt: "x" } },
    };
    const rows = providerDetectedRows({ providerId: "oc", connections: [{ id: "c-oc", provider: "oc", name: "K" }], detectedBudgets, keyless: true });
    expect(rows.map((r) => r.connId)).toEqual(["c-oc"]);
  });

  it("a keyed provider without connections never shows a provider row", () => {
    const detectedBudgets = { glm: { m: { budget: 5, detectedAt: "x" } } };
    expect(providerDetectedRows({ providerId: "glm", connections: [], detectedBudgets })).toEqual([]);
  });
});
