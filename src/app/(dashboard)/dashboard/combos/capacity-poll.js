/**
 * Pure decision for the combo card's capacity-scan poll chain (patch #20,
 * review minor 7). Kept out of page.js so the retry rule is unit-testable.
 *
 * A successful GET keeps polling while the scan reports running, and stops —
 * clearing the "Đang quét…" state — the moment it does not. A FAILED GET no
 * longer kills the chain: it retries on the same cadence up to
 * `maxFailStreak` consecutive failures (the scan may still be running
 * server-side; a dropped chain made the card lie and a re-click just 409'd),
 * then gives up. Any success resets the streak.
 * @param {{ ok: boolean, running: boolean, failStreak?: number, maxFailStreak?: number }} input
 * @returns {{ action: "poll"|"stop", delayMs?: number, failStreak: number }}
 */
export function capacityPollDecision({ ok, running, failStreak = 0, maxFailStreak = 3 } = {}) {
  if (ok) {
    if (running) return { action: "poll", delayMs: 5000, failStreak: 0 };
    return { action: "stop", failStreak: 0 };
  }
  const next = failStreak + 1;
  if (next <= maxFailStreak) return { action: "poll", delayMs: 5000, failStreak: next };
  return { action: "stop", failStreak: next };
}
