/**
 * Fanout model spread (fork patch #22; docs/wavebot-patches.md).
 *
 * Patch #19 ranks ACCOUNTS inside one provider, but a combo's model order never
 * changed, so every request tried model 1 first and only fell through once its
 * lane answered account_busy. For a fanout combo this module reorders the
 * combo's models by lane headroom — the free share of the lane's own budget —
 * so the emptiest lane is tried first and the rest stay as fallback.
 *
 * - A lane is one in-flight pool: a keyless provider is one lane (its provider
 *   id); a keyed provider's lane is its best available account. Models on the
 *   same lane share one ratio and one reservation.
 * - A burst is ordered BEFORE any slot is taken, so a pick is reserved against
 *   its lane until the first model attempt returns; concurrent requests then
 *   see it and spread instead of all choosing the same empty lane.
 * - Prompt-cache affinity: a session keeps its last served model while that
 *   lane has room, and migrates once when the lane is full or locked.
 * - Never drops a model: a full lane, or one with no usable account, sorts to
 *   the back and stays reachable as fallback. Ties keep combo order.
 */

import { getProviderConnections, getSettings } from "@/lib/localDb";
import { isModelLockActive } from "open-sse/services/accountFallback.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getStickyComboModel, setStickyComboModel } from "open-sse/services/systemoneRouter.js";
import { accountInflightLimit, getInflightCount } from "./accountInflight.js";
import { effectiveFanoutBudget, keylessLaneLimit, parseFanoutCtx } from "./fanoutBudget.js";

// A reservation covers the gap between ordering and the first attempt; the TTL
// only stops a lost release from biasing a lane forever.
const RESERVATION_TTL_MS = 60_000;
const reservations = new Set();

const pendingOn = (lane) => {
  const now = Date.now();
  let n = 0;
  for (const r of reservations) {
    if (r.expires <= now) reservations.delete(r);
    else if (r.lane === lane) n += 1;
  }
  return n;
};

/**
 * Headroom of one model's lane: `{ lane, ratio }`. ratio is the free share of
 * the lane budget (1 empty .. 0 full), or -1 when the lane has no usable
 * account. A model that resolves to no provider (a nested combo) is a free lane.
 */
async function laneFor(model, info, fanoutCtx, settings, connectionsFor) {
  if (!info?.provider) return { lane: `unresolved:${model}`, ratio: 1 };
  const providerId = resolveProviderId(info.provider);
  const detected = settings?.detectedBudgets || null;
  const globalLimit = accountInflightLimit();

  if (FREE_PROVIDERS[providerId]?.noAuth) {
    const budget = keylessLaneLimit(
      effectiveFanoutBudget(fanoutCtx, providerId, globalLimit, detected, info.model),
      settings,
    );
    const used = getInflightCount(providerId) + pendingOn(providerId);
    return { lane: providerId, ratio: Math.max(0, 1 - used / budget) };
  }

  const connections = await connectionsFor(providerId);
  let best = { lane: `none:${providerId}`, ratio: -1 };
  for (const c of connections) {
    if (isModelLockActive(c, info.model)) continue;
    const budget = effectiveFanoutBudget(fanoutCtx, c.id, globalLimit, detected, info.model);
    const ratio = Math.max(0, 1 - (getInflightCount(c.id) + pendingOn(c.id)) / budget);
    if (ratio > best.ratio) best = { lane: c.id, ratio };
  }
  return best;
}

/**
 * Order a fanout combo's models by lane headroom and reserve the first pick.
 * @param {object} args
 * @param {string[]} args.models combo members in config order
 * @param {string} args.comboName
 * @param {string|null} args.sessionId
 * @param {unknown} args.fanoutCtx raw combo fanout config (parsed here)
 * @param {(model: string) => Promise<{provider: string|null, model: string}|null>} args.getModelInfo
 * @returns {Promise<{ models: string[], release: () => void }>} release() frees the reservation; idempotent
 */
export async function orderModelsByHeadroom({ models, comboName, sessionId, fanoutCtx, getModelInfo }) {
  const noop = { models, release: () => {} };
  if (!Array.isArray(models) || models.length <= 1) return noop;
  const ctx = parseFanoutCtx(fanoutCtx);
  if (!ctx) return noop;

  const settings = (await getSettings()) || {};
  const cache = new Map();
  const connectionsFor = (providerId) => {
    if (!cache.has(providerId)) cache.set(providerId, getProviderConnections({ provider: providerId, isActive: true }));
    return cache.get(providerId);
  };

  const rows = await Promise.all(models.map(async (model, index) => {
    const info = await getModelInfo(model);
    return { model, index, ...(await laneFor(model, info, ctx, settings, connectionsFor)) };
  }));

  const ordered = [...rows].sort((a, b) => b.ratio - a.ratio || a.index - b.index);

  const stickyModel = sessionId ? getStickyComboModel(comboName, sessionId, models) : null;
  if (stickyModel) {
    const sticky = ordered.find((r) => r.model === stickyModel);
    if (sticky && sticky.ratio > 0) {
      ordered.splice(ordered.indexOf(sticky), 1);
      ordered.unshift(sticky);
    }
  }

  const first = ordered[0];
  const token = { lane: first.lane, expires: Date.now() + RESERVATION_TTL_MS };
  if (first.ratio >= 0) reservations.add(token);
  return { models: ordered.map((r) => r.model), release: () => { reservations.delete(token); } };
}

/** Remember the model that served a session so its next turn keeps the cache warm. */
export function rememberServedModel(comboName, sessionId, model) {
  if (sessionId) setStickyComboModel(comboName, sessionId, model);
}

export function __resetFanoutModels() {
  reservations.clear();
}
