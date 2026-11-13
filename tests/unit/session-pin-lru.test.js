import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetSessionPins,
  getPinnedConnectionId,
  getSessionPinCount,
  pinSession,
} from "../../src/sse/services/sessionPin.js";

const MAX_PINS = 5000;

beforeEach(() => __resetSessionPins());

describe("session pin eviction is least-recently-USED", () => {
  it("a pin that was just read outlives an older untouched one when the cap is hit", () => {
    for (let i = 0; i < MAX_PINS; i += 1) pinSession("openai", `s${i}`, "a");
    expect(getSessionPinCount()).toBe(MAX_PINS);

    // s0 is the oldest INSERT, but an active conversation just used it.
    expect(getPinnedConnectionId("openai", "s0")).toBe("a");

    pinSession("openai", "overflow", "a");

    expect(getSessionPinCount()).toBe(MAX_PINS);
    expect(getPinnedConnectionId("openai", "s0")).toBe("a");
    expect(getPinnedConnectionId("openai", "s1")).toBeNull();
  });
});
