/**
 * Capacity probe error classifier (patch #20; docs/wavebot-patches.md).
 *
 * Turns one probe failure into a reason the scan can act on: `throttle`
 * (transient — retry later, keep the budget), `quota` (the plan's allowance is
 * spent — a MEASURED zero), `auth`, `balance` and `config` (terminal for this
 * key/model — record and skip), `network` (retry, no signal). Order matters: transport-level failures first (no HTTP status to
 * read), then the per-provider response-code map (a provider code says more
 * than the HTTP status wrapping it), then generic HTTP heuristics. Anything
 * unmatched is `throttle` — the conservative default: the scan reads a LOW
 * budget or none, it never over-runs one.
 */

// Substring maps per provider id (as stored on providerconnections / the
// combo's legs). z.ai aliases share one map. Extend here when the scan meets
// a new provider's refusal dialect.
export const PROVIDER_THROTTLE_CODES = {
  glm: { "1305": "throttle", "1113": "balance", "1211": "config", "1002": "auth", "1003": "auth" },
  "glm-cn": { "1305": "throttle", "1113": "balance", "1211": "config", "1002": "auth", "1003": "auth" },
  "z.ai": { "1305": "throttle", "1113": "balance", "1211": "config", "1002": "auth", "1003": "auth" },
};

// A plan whose allowance is spent answers 429 with a typed error, not a rate
// limit: opencode-go's GoUsageLimitError. Terminal for the model and a REAL
// measurement of zero, so the scan stores budget 0 instead of leaving the
// previous value untouched.
const QUOTA_HINTS = /GoUsageLimitError|usage limit reached\s*\(monthly/i;

const NETWORK_HINTS = ["timeout", "econn", "enotfound", "abort"];
const GENERIC_THROTTLE = /rate limit|too many requests|overloaded|resource exhausted/i;

/**
 * Classify one probe failure.
 * @param {{ provider?: string|null, status?: number|null, bodyText?: string|null }} input
 * @returns {"throttle"|"quota"|"auth"|"balance"|"config"|"network"}
 */
export function classifyProbeError({ provider, status, bodyText } = {}) {
  const body = typeof bodyText === "string" ? bodyText : "";
  const lower = body.toLowerCase();

  // 1. Transport-level: the fetch itself failed, there is no HTTP status.
  if ((status === null || status === undefined) && NETWORK_HINTS.some((h) => lower.includes(h))) {
    return "network";
  }

  // 2. Provider response codes — a substring on the body; the code says
  //    precisely why, so it outranks the wrapping status.
  const map = PROVIDER_THROTTLE_CODES[(provider || "").toLowerCase()];
  if (map) {
    for (const [code, reason] of Object.entries(map)) {
      if (body.includes(code)) return reason;
    }
  }

  // 3. Generic HTTP heuristics.
  if (QUOTA_HINTS.test(body)) return "quota";
  if (status === 429 || GENERIC_THROTTLE.test(body)) return "throttle";
  if (status === 401 || status === 403) return "auth";
  if (status === 404 && /model/i.test(body)) return "config";

  // Conservative default: reads low, never over-runs.
  return "throttle";
}
