import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache, getAntigravityModelQuota } from "./antigravityQuota.js";
// Fork patch #4: session → account affinity (see sessionPin.js).
import { getPinnedConnectionId } from "./sessionPin.js";
// Fork patch #5: per-account in-flight cap, acquired inside the selection mutex.
import {
  accountInflightLimit,
  getInflightCount,
  tryAcquireAccountSlot,
  createWaitTicket,
  waitForCapacity,
  recordAccountBusy,
  setRuntimeLimits,
  getUpstreamWaitMs,
} from "./accountInflight.js";
import * as log from "../utils/logger.js";
// Fork patch #19: combo-scoped fanout — per-account budgets + headroom ranking.
import { parseFanoutCtx, effectiveFanoutBudget, rankFanout } from "./fanoutBudget.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Fork patch #18: at the in-flight cap, wait (priority-ordered) instead of
  // answering account_busy at once. The wait is OUTSIDE the selection mutex.
  try {
    const stored = await getSettings();
    setRuntimeLimits({ accountMaxInflight: stored?.accountMaxInflight, upstreamWaitMs: stored?.upstreamWaitMs });
  } catch {
    // keep the last applied limits
  }
  // Only callers that opt in (chat) wait; every other handler keeps the immediate account_busy.
  const asked = options?.upstreamWaitMs ?? (options?.wait ? getUpstreamWaitMs() : 0);
  const waitMs = Number(asked) > 0 ? Number(asked) : 0;
  const deadline = Date.now() + waitMs;
  const ticket = createWaitTicket(options?.priority);
  for (;;) {
    const result = await selectProviderCredentials(provider, excludeConnectionIds, model, options);
    if (result?.lastErrorCode !== "account_busy") return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !(await waitForCapacity(ticket, remaining))) {
      recordAccountBusy();
      return result;
    }
  }
}

async function selectProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  // Fork patch #4: the conversation identity, when the caller resolved one.
  const sessionId = options?.sessionId || null;
  // Fork patch #19: when the request rides a fanout combo, each account runs at
  // its OWN budget (settings.budgets entry, else the global limit) and selection
  // ranks by free headroom instead of the provider strategy. Parsed exactly here.
  const fanoutCtx = parseFanoutCtx(options?.fanout);
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Fork patch #5: an account at its in-flight cap is temporarily unusable —
    // distinct from locked (which has a known reset) and from empty.
    const inflightLimit = accountInflightLimit();
    // Patch #20 capacity scan: the detected (connection, model) budget is the
    // base cap for EVERY strategy (ruling 2026-11-15); a model the scan never
    // measured keeps the global limit (ruling 2026-11-16).
    const detectedBudgets = (await getSettings())?.detectedBudgets || null;
    const limitFor = (c) => effectiveFanoutBudget(fanoutCtx, c.id, inflightLimit, detectedBudgets, model);
    let busyCount = 0;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      if (getInflightCount(c.id) >= limitFor(c)) {
        busyCount += 1;
        return false;
      }
      const enabled = c.providerSpecificData?.enabledModels;
      if (providerId === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const connQuotas = antigravityQuotaCache.get(c.id);
        const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
          const resetAt = quota?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      // Fork patch #5: every account is merely BUSY. That is a retryable 503,
      // never "no credentials" (404) — the accounts exist and will free up.
      if (busyCount > 0 && lockedConns.length === 0) {
        const retryAfter = new Date(Date.now() + 2000).toISOString();
        log.warn("AUTH", fanoutCtx
          ? `${provider} | all ${connections.length} accounts at their in-flight budgets (Σ ${connections.reduce((s, c) => s + limitFor(c), 0)})`
          : `${provider} | all ${connections.length} accounts at max in-flight (${inflightLimit})`);
        return {
          allRateLimited: true,
          retryAfter,
          retryAfterHuman: "2s",
          lastError: "All accounts at max in-flight",
          lastErrorCode: "account_busy",
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    // Fork patch #4: otherwise keep a conversation on the account that last
    // served it — prompt-cache affinity. Looked up in the ALREADY-FILTERED set,
    // so a locked/unavailable pin falls through to the normal strategy instead
    // of being honoured.
    if (!connection && sessionId) {
      const pinnedId = getPinnedConnectionId(providerId, sessionId);
      if (pinnedId) {
        const pinned = availableConnections.find((c) => c.id === pinnedId);
        if (pinned) {
          connection = pinned;
          log.info("AUTH", `${provider} | session pin ${pinned.id?.slice(0, 8)} (${pinned.name || pinned.email || "unnamed"}) for ${sessionId}`);
        } else {
          log.info("AUTH", `${provider} | session pin ${pinnedId?.slice(0, 8)} unavailable for ${sessionId}, rotating`);
        }
      }
    }
    if (connection) {
      // skip strategy
    } else if (fanoutCtx) {
      // Fork patch #19: fanout ranks by how much of each account's OWN budget is
      // free, so a big-budget account with more absolute load still wins over a
      // small-budget account that is nearly full. Overrides the provider strategy
      // for this leg; recency is an input, so it persists like spread does.
      const ranked = rankFanout(availableConnections.map((c) => ({
        id: c.id,
        budget: limitFor(c),
        inflight: getInflightCount(c.id),
        backoffLevel: c.backoffLevel || 0,
        lastUsedAt: c.lastUsedAt || "",
        priority: c.priority ?? 999,
      })));
      connection = availableConnections.find((c) => c.id === ranked[0].id);
      log.info("AUTH", `${provider} | fanout → ${connection.id?.slice(0, 8)} (inflight ${getInflightCount(connection.id)}/${limitFor(connection)})`);
      await updateProviderConnection(connection.id, { lastUsedAt: new Date().toISOString() });
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else if (strategy === "spread") {
      // Fork patch #6: spread the load. Priority alone funnels every request at
      // the best account until it is at its cap; this scores the already-
      // available set by how much room it actually has, so parallel traffic
      // fans out while prompt-cache affinity (above) is untouched.
      const recency = (c) => {
        const t = Date.parse(c.lastUsedAt || "");
        return Number.isFinite(t) ? t : 0; // never used sorts first
      };
      const ranked = [...availableConnections].sort((a, b) =>
        (getInflightCount(a.id) - getInflightCount(b.id))
        || ((a.backoffLevel || 0) - (b.backoffLevel || 0))
        || (recency(a) - recency(b))
        || ((a.priority || 999) - (b.priority || 999)));
      connection = ranked[0];
      log.info("AUTH", `${provider} | spread → ${connection.id?.slice(0, 8)} (inflight ${getInflightCount(connection.id)})`);
      // Recency is an input to the next pick, so it must persist.
      await updateProviderConnection(connection.id, { lastUsedAt: new Date().toISOString() });
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    // Fork patch #5: take the slot while still inside the selection mutex, so
    // no concurrent selector can pick the same account past its cap. The
    // release sites are the same ones that decrement the pending tracker.
    if (!tryAcquireAccountSlot(connection.id, limitFor(connection))) {
      // The account filled between choosing it and taking its slot. Serving it
      // anyway would make the cap advisory; answer the same retryable busy
      // state as the all-accounts-full path, which callers already handle.
      log.warn("AUTH", `${provider} | slot race on ${connection.id?.slice(0, 8)} — account now at ${fanoutCtx ? `its in-flight budget (${limitFor(connection)})` : `max in-flight (${inflightLimit})`}`);
      return {
        allRateLimited: true,
        retryAfter: new Date(Date.now() + 2000).toISOString(),
        retryAfterHuman: "2s",
        lastError: "All accounts at max in-flight",
        lastErrorCode: "account_busy",
      };
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
