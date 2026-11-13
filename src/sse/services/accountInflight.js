/**
 * Per-account in-flight semaphore (fork patch #5; docs/wavebot-patches.md).
 *
 * Upstream tracks pending requests (`trackPendingRequest`), but the increment
 * happens AFTER an account is chosen, so two simultaneous requests can both
 * pick the emptiest account and overshoot its cap. This module is acquired
 * inside auth.js's selection mutex — the same critical section that chooses
 * the account — which closes that race, and it also feeds the `spread`
 * strategy's score.
 *
 * Why a cap at all: one upstream credential hammered by many parallel turns
 * is the fastest way to earn provider-side rate limiting; keeping each account
 * under `ACCOUNT_MAX_INFLIGHT` spends the same total capacity more evenly.
 *
 * TTL: a slot whose release site never ran (a path we did not anticipate)
 * must not leak forever. Ten minutes is far longer than any real request, so
 * an expired entry is a leak, and dropping it recovers capacity.
 */

const SLOT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 4;

/** connectionId -> { count, expiresAt } */
const slots = new Map();

function live(connectionId) {
  const entry = slots.get(connectionId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    slots.delete(connectionId);
    return null;
  }
  return entry;
}

export function accountInflightLimit() {
  const raw = Number(process.env.ACCOUNT_MAX_INFLIGHT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
}

export function getInflightCount(connectionId) {
  if (!connectionId) return 0;
  const entry = live(connectionId);
  return entry ? entry.count : 0;
}

export function tryAcquireAccountSlot(connectionId, limit = accountInflightLimit()) {
  if (!connectionId) return true;
  const entry = live(connectionId);
  const count = entry ? entry.count : 0;
  if (count >= limit) return false;
  slots.set(connectionId, { count: count + 1, expiresAt: Date.now() + SLOT_TTL_MS });
  return true;
}

export function releaseAccountSlot(connectionId) {
  if (!connectionId) return;
  const entry = live(connectionId);
  if (!entry) return;
  if (entry.count <= 1) {
    slots.delete(connectionId);
    return;
  }
  slots.set(connectionId, { count: entry.count - 1, expiresAt: entry.expiresAt });
}

/**
 * Wrap a Response whose body is still being streamed, releasing the slot when
 * the body ends, errors or is cancelled.
 *
 * Some handlers return the live upstream stream (codex image generation, the
 * Gemini-native proxy). Releasing at return would free the account while the
 * transfer is still in flight, which is the over-count this semaphore exists
 * to prevent. A bodiless response releases immediately.
 */
export function releaseSlotWithBody(response, connectionId) {
  if (!response.body) {
    releaseAccountSlot(connectionId);
    return response;
  }
  const reader = response.body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseAccountSlot(connectionId);
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Test-only. */
export function __resetAccountInflight() {
  slots.clear();
}
