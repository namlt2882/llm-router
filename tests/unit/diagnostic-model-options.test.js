import { describe, expect, it } from "vitest";
import { diagnosticModelOptions } from "../../src/app/(dashboard)/dashboard/providers/[id]/diagnostic-model-options.js";

// Patch #20 follow-up: the diagnostic picker must offer the provider's LIVE
// available models, not just the static catalog. opencode free is the driving
// case — its real catalog (mimo-v2.6-flash-free, …) arrives via modelsFetcher
// as "suggested models" and never reached the picker (static catalog: 4 rows).
describe("diagnosticModelOptions", () => {
  it("keeps the catalog as-is when there are no suggested models", () => {
    const catalog = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    expect(diagnosticModelOptions(catalog, [])).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
  });

  it("appends suggested models missing from the catalog, catalog order first", () => {
    const catalog = [{ id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2" }];
    const suggested = [
      { id: "mimo-v2.6-flash-free", name: "MiMo v2.6 Flash Free", contextLength: 200000 },
      { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 (dup)" },
    ];
    const out = diagnosticModelOptions(catalog, suggested);
    expect(out.map((m) => m.id)).toEqual(["muse-spark-1.2-contributor-free", "mimo-v2.6-flash-free"]);
    // First occurrence wins — the catalog entry keeps its own name.
    expect(out[0].name).toBe("Muse Spark 1.2");
    expect(out[1].name).toBe("MiMo v2.6 Flash Free");
  });

  it("accepts string entries and normalizes them (first occurrence wins)", () => {
    expect(diagnosticModelOptions(["s"], [{ id: "s", name: "S" }])).toEqual([{ id: "s", name: "s" }]);
    expect(diagnosticModelOptions([{ id: "a" }], [])).toEqual([{ id: "a", name: "a" }]);
    expect(diagnosticModelOptions([{ id: "a" }], [{ id: "b", name: "B" }])).toEqual([
      { id: "a", name: "a" },
      { id: "b", name: "B" },
    ]);
  });

  it("tolerates null on either side", () => {
    expect(diagnosticModelOptions(null, [{ id: "x", name: "X" }])).toEqual([{ id: "x", name: "X" }]);
    expect(diagnosticModelOptions([{ id: "y", name: "Y" }], null)).toEqual([{ id: "y", name: "Y" }]);
    expect(diagnosticModelOptions(null, null)).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const catalog = [{ id: "a", name: "A" }];
    const suggested = [{ id: "b", name: "B" }];
    diagnosticModelOptions(catalog, suggested);
    expect(catalog).toEqual([{ id: "a", name: "A" }]);
    expect(suggested).toEqual([{ id: "b", name: "B" }]);
  });
});
