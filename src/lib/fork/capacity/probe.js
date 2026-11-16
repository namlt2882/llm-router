/**
 * Capacity probe engine (patch #20; docs/wavebot-patches.md).
 *
 * Measures one (connection, model) concurrency limit by ramping bursts of
 * tiny real completions: 1, 2, 4, 8, 16, 32, refined by up to two binary
 * search steps between the last all-success level and the first failing
 * one. The probe calls upstream DIRECTLY through the injected dispatch —
 * never through the router's own account selection, which would acquire
 * the very in-flight slots it is trying to measure above the global cap.
 * `makeDefaultDispatch` is the real dispatch (openai transport, Bearer,
 * 8-token completion); the orchestrator injects it per connection after
 * checkAndRefreshToken and skips connections it cannot dispatch for.
 */
import registry from "open-sse/providers/registry/index.js";
import { getExecutor } from "open-sse/executors/index.js";
import { classifyProbeError } from "./classifyError.js";

/**
 * Ramp schedule, truncated at maxLevel.
 * @param {number} [maxLevel=32]
 * @returns {number[]}
 */
export function rampLevels(maxLevel = 32) {
  return [1, 2, 4, 8, 16, 32].filter((level) => level <= maxLevel);
}

const UNSUPPORTED = { status: "unsupported", reason: "provider type not supported for probing" };

const snippet = (fail) => String(fail?.bodyText || "").slice(0, 200);

/**
 * Probe one (connection, model) pair.
 * @param {{ provider: string, connection: object, model: string, maxLevel?: number, dispatch: (task: {provider: string, connection: object, model: string}) => Promise<{ok: true} | {ok: false, status?: number|null, bodyText?: string, unsupported?: true}> }} input
 * @returns {Promise<{ status: "ok", budget: number } | { status: "unknown"|"unreachable"|"auth"|"config"|"balance"|"throttle"|"unsupported", reason?: string }>}
 */
export async function probeConnectionModel({ provider, connection, model, maxLevel = 32, dispatch = makeDefaultDispatch() }) {
  const levels = rampLevels(maxLevel);
  if (!levels.length) return { status: "unknown", reason: `no ramp level within maxLevel ${maxLevel}` };

  let lo = 0; // last all-success level (0 = even the first burst failed)
  let hi = null; // first failing level
  let failInfo = null;
  let requests = 0; // total upstream dispatches — the scan's audit trail

  // Fire `level` concurrent probes; the level passes iff every call is ok.
  const runLevel = async (level) => {
    requests += level;
    const settled = await Promise.allSettled(
      Array.from({ length: level }, () => dispatch({ provider, connection, model }))
    );
    for (const r of settled) {
      // A rejected dispatch is definitionally transport-level — the fetch
      // itself threw — so it carries the transport flag for classification.
      const value = r.status === "fulfilled" ? r.value : { ok: false, status: null, bodyText: String(r.reason?.message || r.reason), transportError: true };
      if (value?.unsupported) return { unsupported: true };
      if (!value?.ok) return { failed: value };
    }
    return { passed: true };
  };

  for (const level of levels) {
    const outcome = await runLevel(level);
    if (outcome.unsupported) return { ...UNSUPPORTED, requests };
    if (outcome.failed) { hi = level; failInfo = outcome.failed; break; }
    lo = level;
  }

  if (hi === null) return { status: "ok", budget: lo, requests };

  // The very first burst failed: there is no budget to report — classify why.
  if (lo === 0) {
    const kind = failInfo?.transportError
      ? "network"
      : classifyProbeError({ provider, status: failInfo?.status, bodyText: failInfo?.bodyText });
    if (kind === "network") return { status: "unreachable", reason: snippet(failInfo), requests };
    return { status: kind, reason: snippet(failInfo), requests };
  }

  // Up to two binary-search steps between lo (pass) and hi (fail); once they
  // are adjacent, every integer in between is lo or hi — both already probed.
  for (let step = 0; step < 2 && hi - lo > 1; step++) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (mid <= lo || mid >= hi) break;
    const outcome = await runLevel(mid);
    if (outcome.unsupported) return { ...UNSUPPORTED, requests };
    if (outcome.failed) { hi = mid; failInfo = outcome.failed; } else { lo = mid; }
  }

  return { status: "ok", budget: lo, requests };
}

/**
 * The real dispatch: resolve the provider's openai transport from the
 * registry and fire one minimal non-streaming completion at it. No slot
 * acquisition, no session pin, no proxy (proxied connections are the
 * orchestrator's skip — see Task 5). Returns `{ok:false, unsupported:true}`
 * when the provider exposes no openai-format transport.
 * @param {{ fetchImpl?: typeof fetch, dispatcher?: unknown, probeTimeoutMs?: number }} [options]
 */
export function makeDefaultDispatch({ fetchImpl = fetch, dispatcher = null, probeTimeoutMs = 15000 } = {}) {
  return async function dispatch({ provider, connection, model }) {
    const entry = Array.isArray(registry) ? registry.find((p) => p?.id === provider) : null;
    const transport = entry?.transports?.find((t) => t?.format === "openai");
    if (!transport) return { ok: false, unsupported: true };

    const connData = connection?.data && typeof connection.data === "object" ? connection.data : {};
    const baseUrl = connection?.providerSpecificData?.baseUrl || transport.baseUrl;
    const token = connection?.apiKey || connection?.accessToken || connData.apiKey || connData.accessToken;
    const headers = { "content-type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetchImpl(baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 8, stream: false }),
        signal: AbortSignal.timeout(probeTimeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
      });
      const bodyText = await res.text();
      if (res.status === 200) {
        try {
          const parsed = JSON.parse(bodyText);
          if (parsed && Array.isArray(parsed.choices) && parsed.choices.length > 0) return { ok: true };
        } catch { /* fall through to the failure below */ }
      }
      return { ok: false, status: res.status, bodyText };
    } catch (e) {
      return { ok: false, status: null, bodyText: String(e?.message || e) };
    }
  };
}

const drainResponse = async (response) => {
  if (typeof response?.text === "function") return response.text();
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += typeof value === "string" ? value : new TextDecoder().decode(value);
    }
    return text;
  }
  return "";
};

/**
 * Executor-backed dispatch for providers whose live lane the generic openai
 * POST can never reach (opencode free: TLS-ClientHello gate + forced
 * streaming). Drives the provider's REAL executor — its transformRequest
 * (stream forcing, fingerprint tools), its session headers, and its
 * impersonating fetch — so the probe measures exactly the lane live traffic
 * uses. Credentials stay empty: keyless providers mint per-request state
 * themselves. A provider with no executor is unsupported for this path.
 * @param {{ probeTimeoutMs?: number }} [options]
 */
export function makeExecutorDispatch({ probeTimeoutMs = 15000 } = {}) {
  return async function dispatch({ provider, model }) {
    const executor = getExecutor(provider);
    if (!executor) return { ok: false, unsupported: true };
    try {
      const { response } = await executor.execute({
        model,
        body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 8, stream: true },
        stream: true,
        credentials: {},
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      const bodyText = await drainResponse(response);
      if (response?.ok) return { ok: true };
      return { ok: false, status: response?.status ?? null, bodyText };
    } catch (e) {
      return { ok: false, status: null, bodyText: String(e?.message || e) };
    }
  };
}

/**
 * Pick the dispatch a provider is actually probeable through: an openai-format
 * transport goes through the generic fetch path (Bearer, non-streaming —
 * cheapest); every other provider goes through its executor, which reports
 * unsupported when none exists. Registered in the scan's default probeFn so
 * the DEFAULT wiring reaches executor-only providers too.
 * @param {string} provider
 * @returns {(task: {provider: string, connection: object, model: string}) => Promise<{ok: true} | {ok: false, status?: number|null, bodyText?: string, unsupported?: true}>}
 */
export function dispatchFor(provider) {
  const entry = Array.isArray(registry) ? registry.find((p) => p?.id === provider) : null;
  if (entry?.transports?.some((t) => t?.format === "openai")) return makeDefaultDispatch();
  return makeExecutorDispatch();
}
