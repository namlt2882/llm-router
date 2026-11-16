import { describe, expect, it } from "vitest";
import { nextCapacityScanEnabled } from "../../src/app/(dashboard)/dashboard/providers/[id]/capacity-scan-enabled.js";

// Review minor 8: the on-switch (first diagnostic model saved) had no
// off-switch — removing the last model left the daily scan enabled with
// nothing to scan. The decision is derived from the before/after maps.
describe("nextCapacityScanEnabled", () => {
  it("turns on when the map goes empty to non-empty", () => {
    expect(nextCapacityScanEnabled({}, { glm: ["glm-5.3-flash"] })).toBe(true);
    expect(nextCapacityScanEnabled({ glm: [] }, { glm: ["m"] })).toBe(true);
  });

  it("turns OFF when the last model is removed", () => {
    expect(nextCapacityScanEnabled({ glm: ["m"] }, {})).toBe(false);
    expect(nextCapacityScanEnabled({ glm: ["m"] }, { glm: [] })).toBe(false);
    expect(nextCapacityScanEnabled({ glm: ["m"], oc: ["n"] }, { glm: [], oc: [] })).toBe(false);
  });

  it("keeps the current value when nothing was configured on either side", () => {
    expect(nextCapacityScanEnabled({}, {})).toBeUndefined();
    expect(nextCapacityScanEnabled(null, {})).toBeUndefined();
  });

  it("stays on (idempotent write) when models remain on both sides", () => {
    expect(nextCapacityScanEnabled({ glm: ["a"] }, { glm: ["a", "b"] })).toBe(true);
  });
});
