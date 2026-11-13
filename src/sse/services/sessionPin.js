/**
 * Session → upstream account affinity (fork patch #4; docs/wavebot-patches.md).
 *
 * A conversation re-sends the same prefix on every turn, and a provider only
 * gets a prompt-cache hit when consecutive turns land on the SAME account. The
 * default strategies (fill-first, round-robin) spread accounts for capacity and
 * break that hit rate. This map remembers which account last served a session
 * and lets selection prefer it — WHILE it is available. Affinity never overrides
 * availability: auth.js only consults the pin inside the already-filtered
 * available set, so a model-locked pin rotates immediately.
 *
 * Memory-held on purpose: it is routing affinity, not state. A restart costs
 * one cache miss per active conversation and nothing else.
 */

const PIN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PINS = 5000;

/** key -> { connectionId, lastUsed } */
const pins = new Map();

function key(providerId, sessionId) {
  return `${providerId}:${sessionId}`;
}

export function getPinnedConnectionId(providerId, sessionId) {
  if (!providerId || !sessionId) return null;
  const k = key(providerId, sessionId);
  const entry = pins.get(k);
  if (!entry) return null;
  if (entry.lastUsed + PIN_TTL_MS <= Date.now()) {
    pins.delete(k);
    return null;
  }
  // Refresh recency; eviction walks Map insertion order, so move it to the end.
  entry.lastUsed = Date.now();
  pins.delete(k);
  pins.set(k, entry);
  return entry.connectionId;
}

export function pinSession(providerId, sessionId, connectionId) {
  if (!providerId || !sessionId || !connectionId) return;
  const k = key(providerId, sessionId);
  pins.delete(k);
  pins.set(k, { connectionId, lastUsed: Date.now() });
  while (pins.size > MAX_PINS) {
    const oldest = pins.keys().next().value;
    pins.delete(oldest);
  }
}

export function getSessionPinCount() {
  return pins.size;
}

/** Test-only: drop every pin. */
export function __resetSessionPins() {
  pins.clear();
}
