import { describe, expect, it } from "vitest";
import { capacityPollDecision } from "../../src/app/(dashboard)/dashboard/combos/capacity-poll.js";

// Review minor 7: one failed GET mid-scan must not kill the poll chain — the
// card would drop "Đang quét…" while the scan continues server-side, and a
// re-click just 409s. Failures retry up to a bounded streak.
describe("capacityPollDecision", () => {
  it("keeps polling while a scan is running", () => {
    expect(capacityPollDecision({ ok: true, running: true, failStreak: 0 }))
      .toEqual({ action: "poll", delayMs: 5000, failStreak: 0 });
  });

  it("stops when the scan finished", () => {
    expect(capacityPollDecision({ ok: true, running: false, failStreak: 2 }))
      .toEqual({ action: "stop", failStreak: 0 });
  });

  it("retries after a failed GET instead of dropping the chain", () => {
    expect(capacityPollDecision({ ok: false, running: true, failStreak: 0 }))
      .toEqual({ action: "poll", delayMs: 5000, failStreak: 1 });
    expect(capacityPollDecision({ ok: false, running: true, failStreak: 1 }))
      .toEqual({ action: "poll", delayMs: 5000, failStreak: 2 });
  });

  it("gives up after the failure streak is exhausted", () => {
    expect(capacityPollDecision({ ok: false, running: true, failStreak: 3 }))
      .toEqual({ action: "stop", failStreak: 4 });
  });

  it("a success resets the failure streak", () => {
    expect(capacityPollDecision({ ok: true, running: true, failStreak: 2 }).failStreak).toBe(0);
  });
});
