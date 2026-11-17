/**
 * Live-traffic quota collapse (docs/superpowers/specs/
 * 2026-11-16-live-quota-and-concurrency-tab-design.md, Part 1).
 *
 * When a REAL request hits an upstream quota, the account's (connection,
 * model) budget must drop to 0 immediately — not at the next daily scan —
 * and, when the error states a reset time within 24h, a re-check is
 * scheduled for exactly that moment so the lane reopens by itself.
 */

import { getSettings, updateSettings } from "@/lib/localDb";
import { matchesQuotaHints } from "@/lib/fork/capacity/classifyError.js";

const RECHECK_HORIZON_MS = 24 * 60 * 60 * 1000;

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

/**
 * Collapse one (connection, model) lane after a live quota error: write
 * `detectedBudgets[connectionId][model] = { budget: 0, quota: true, ... }`
 * — the terminal-0 shape the budget chain already reads — and, when the
 * error states a reset within 24h, upsert a `quotaRecheck` entry so the
 * scheduler probes the lane back open at that moment.
 *
 * Quota rule (two signals): the scan's quota hints match, OR the executor
 * handed in a future `resetsAtMs` — executors only parse reset times for
 * quota-window errors (GLM 1308 → UTC+8, codex, antigravity, codebuddy), so
 * a non-null resetsAtMs is itself a quota signal even where the body text
 * alone classifies as throttle.
 *
 * Keyless lanes pass their provider id as connectionId, which is exactly the
 * detectedBudgets key the scan uses for them — no special casing here.
 *
 * @param {{ connectionId?: string, provider?: string|null, model?: string|null,
 *          errorText?: string, resetsAtMs?: number|null }} input
 * @returns {Promise<boolean>} true when the lane was collapsed
 */

// Collapse and recheck both read-modify-write settings maps
// (detectedBudgets / quotaRecheck). updateSettings is transactional per call,
// but it merges at TOP-LEVEL key granularity from the row's current state —
// so two RMWs whose maps were computed from the same snapshot replace, not
// merge, each other's whole map. A fanout burst (several accounts hitting
// their quota at once) produces exactly that interleave, and a lost collapse
// is not re-triggered: admission stops sending traffic to the lane it
// collapsed. One in-process promise chain serializes every quota settings
// RMW. The capacity scan is deliberately NOT under this lock — it runs for
// minutes and holding the lock that long would stall live collapses; its own
// scanInFlight guard bounds it to one writer, and a collapse lost to a
// running scan resurfaces at that scan's next run.
let quotaSettingsChain = Promise.resolve();
export function withQuotaSettingsLock(fn) {
  const run = quotaSettingsChain.then(fn, fn);
  quotaSettingsChain = run.then(() => {}, () => {});
  return run;
}

async function handleLiveQuotaErrorInner({ connectionId, provider, model, errorText, resetsAtMs } = {}) {
  if (!connectionId || !model) return false;
  const now = Date.now();
  const futureReset = Number.isFinite(resetsAtMs) && resetsAtMs > now;
  if (!matchesQuotaHints(errorText) && !futureReset) return false;

  const settings = await getSettings();
  const detectedBudgets = settings?.detectedBudgets && typeof settings.detectedBudgets === "object"
    ? { ...settings.detectedBudgets }
    : {};
  const lane = detectedBudgets[connectionId] && typeof detectedBudgets[connectionId] === "object"
    ? { ...detectedBudgets[connectionId] }
    : {};
  const existing = lane[model];
  // The stash survives repeated collapses: a second in-flight request on the
  // same lane erroring before the reset (the normal fanout shape) re-enters
  // here with {budget: 0, quota: true, previousBudget: 4} — taking the
  // budget as the stash there would overwrite the known 4 with nothing, and
  // the eventual restore would fall back to the global cap instead of the
  // measured budget. A re-collapse also keeps the first detection time and
  // the scan's unbounded marker so the collapse/restore round-trip is
  // information-preserving.
  const previousBudget = existing?.quota
    ? (Number.isFinite(Number(existing?.previousBudget)) ? Number(existing.previousBudget) : undefined)
    : (existing && Number.isFinite(Number(existing.budget)) ? Number(existing.budget) : undefined);
  lane[model] = {
    budget: 0,
    quota: true,
    ...(previousBudget !== undefined ? { previousBudget } : {}),
    ...(existing?.unbounded ? { unbounded: true } : {}),
    detectedAt: existing?.quota && existing.detectedAt ? existing.detectedAt : new Date(now).toISOString(),
    source: "live",
  };
  detectedBudgets[connectionId] = lane;

  const patch = { detectedBudgets };
  // parseResetsIn yields a DURATION ("resets in 5h" → 18e6 ms); the executor's
  // resetsAtMs is already an epoch instant. Normalize to an instant first or
  // the horizon check compares a duration against Date.now() and never passes.
  let resetsAt = null;
  if (futureReset) {
    resetsAt = resetsAtMs;
  } else {
    const duration = parseResetsIn(errorText);
    if (duration) resetsAt = now + duration;
  }
  if (resetsAt && resetsAt > now && resetsAt - now <= RECHECK_HORIZON_MS) {
    const queue = Array.isArray(settings?.quotaRecheck) ? settings.quotaRecheck.filter((e) => e && (e.connectionId !== connectionId || e.model !== model)) : [];
    queue.push({ connectionId, provider: provider || null, model, at: new Date(resetsAt).toISOString() });
    patch.quotaRecheck = queue;
  } else if (Array.isArray(settings?.quotaRecheck)) {
    patch.quotaRecheck = settings.quotaRecheck;
  }
  await updateSettings(patch);
  return true;
}

export function handleLiveQuotaError(input) {
  return withQuotaSettingsLock(() => handleLiveQuotaErrorInner(input));
}
