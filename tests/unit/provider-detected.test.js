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

  it("collects provider-keyed and per-connection entries", () => {
    const detectedBudgets = {
      glm: { "glm-5.3-flash": { budget: 5, detectedAt: "2026-11-16T03:32:03.984Z" } },
      "c-1": { "glm-5.3-flash": { budget: 4, detectedAt: "2026-11-16T04:00:00.000Z" } },
      "c-x": { "m": { budget: 9, detectedAt: "2026-11-16T04:00:00.000Z" } },
    };
    const rows = providerDetectedRows({ providerId: "glm", connections, detectedBudgets });
    // per-connection rows (specific) come first; the provider-level fallback
    // row last — its connId is the settings key itself (the provider id).
    expect(rows.map((r) => [r.connId, r.model, r.budget])).toEqual([
      ["c-1", "glm-5.3-flash", 4],
      ["glm", "glm-5.3-flash", 5],
    ]);
    expect(rows[0].detectedAt).toBe("2026-11-16T04:00:00.000Z");
    expect(rows[0].connName).toBe("Nam");
    expect(rows[1].connName).toBeNull();
  });

  it("sorts by connection name then model", () => {
    const detectedBudgets = {
      "c-2": { "b-model": { budget: 2, detectedAt: "x" }, "a-model": { budget: 3, detectedAt: "x" } },
      "c-1": { "m": { budget: 4, detectedAt: "x" } },
      glm: { "m": { budget: 5, detectedAt: "x" } },
    };
    const rows = providerDetectedRows({ providerId: "glm", connections, detectedBudgets });
    expect(rows.map((r) => `${r.connName || "provider"}/${r.model}`)).toEqual([
      "Key 2/a-model",
      "Key 2/b-model",
      "Nam/m",
      "provider/m",
    ]);
    // connections alphabetical by name, models alphabetical within a
    // connection, provider-level fallback row last
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
});
