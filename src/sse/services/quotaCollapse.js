/**
 * Live-traffic quota collapse (docs/superpowers/specs/
 * 2026-11-16-live-quota-and-concurrency-tab-design.md, Part 1).
 *
 * When a REAL request hits an upstream quota, the account's (connection,
 * model) budget must drop to 0 immediately — not at the next daily scan —
 * and, when the error states a reset time within 24h, a re-check is
 * scheduled for exactly that moment so the lane reopens by itself.
 */

const RESETS_PHRASE = /resets?\s+(?:in|at)\b/i;
const DAYS = /(\d+)\s*d(?:ay)?s?/i;
const HOURS = /(\d+)\s*h(?:our)?s?/i;
const MINUTES = /(\d+)\s*m(?:in(?:ute)?)?s?/i;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Parse a "resets in 8d 4h" / "resets in 5h 20m" style phrase into
 * milliseconds until the reset. Requires the resets-in phrase before any
 * number is trusted, so a quota error without a stated reset parses as null
 * (the daily scan remains that lane's fallback).
 * @param {string|undefined} errorText
 * @returns {number|null}
 */
export function parseResetsIn(errorText) {
  if (typeof errorText !== "string" || !RESETS_PHRASE.test(errorText)) return null;
  let ms = 0;
  let matched = false;
  const d = errorText.match(DAYS);
  const h = errorText.match(HOURS);
  const m = errorText.match(MINUTES);
  if (d) { ms += Number(d[1]) * 24 * HOUR_MS; matched = true; }
  if (h) { ms += Number(h[1]) * HOUR_MS; matched = true; }
  if (m) { ms += Number(m[1]) * MINUTE_MS; matched = true; }
  return matched ? ms : null;
}
