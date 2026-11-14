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
  if (entry.count <= 1) slots.delete(connectionId);
  else slots.set(connectionId, { count: entry.count - 1, expiresAt: entry.expiresAt });
  wakeWaiters();
}

/**
 * Fork patch #12: priority-ordered upstream wait at the cap.
 *
 * When every candidate account is at its in-flight cap a request used to get
 * `account_busy` at once. WaveBot now tags each call with
 * `x-wavebot-priority: interactive|background`; a capped request waits (up to
 * `upstream_wait_ms`) in a queue ordered interactive first, then FIFO. A
 * release wakes EVERY waiter in that order; each retries selection through
 * auth.js's mutex, which is FIFO, so the order of retries is the order of the
 * queue, and a loser simply re-queues with its original ticket (its place is
 * kept). The queue is process memory: a restart drops it, and waits last
 * seconds, so that is acceptable.
 */
const PRIORITY_HEADER = "x-wavebot-priority";
const BUSY_WINDOW_MS = 5 * 60 * 1000;
let ticketSeq = 0;
/** ticket -> { wake(boolean) } for tickets currently waiting */
const waiting = new Map();
let busyStamps = [];

export function parsePriority(headers) {
  let raw = null;
  if (headers && typeof headers.get === "function") raw = headers.get(PRIORITY_HEADER);
  else if (headers) raw = headers[PRIORITY_HEADER] ?? headers[PRIORITY_HEADER.toUpperCase()] ?? null;
  return String(raw || "").toLowerCase() === "interactive" ? "interactive" : "background";
}

export function createWaitTicket(priority = "background") {
  return { priority: priority === "interactive" ? "interactive" : "background", seq: ++ticketSeq, enqueuedAt: Date.now() };
}

function ordered() {
  return [...waiting.keys()].sort(
    (a, b) => (a.priority === b.priority ? 0 : a.priority === "interactive" ? -1 : 1) || a.seq - b.seq,
  );
}

function wakeWaiters() {
  for (const ticket of ordered()) {
    const entry = waiting.get(ticket);
    waiting.delete(ticket);
    entry?.wake(true);
  }
}

/** Resolves true when woken by a release, false on timeout, abort or waitMs <= 0. */
export function waitForCapacity(ticket, waitMs, signal) {
  if (!(waitMs > 0) || signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer = null;
    const done = (value) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      waiting.delete(ticket);
      done(false);
    };
    timer = setTimeout(() => {
      waiting.delete(ticket);
      done(false);
    }, waitMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.set(ticket, { wake: done });
  });
}

export function recordAccountBusy() {
  busyStamps.push(Date.now());
}

export function getQueueStats() {
  const now = Date.now();
  busyStamps = busyStamps.filter((t) => now - t < BUSY_WINDOW_MS);
  const queued = { interactive: 0, background: 0 };
  let oldest = 0;
  for (const ticket of waiting.keys()) {
    queued[ticket.priority] += 1;
    oldest = Math.max(oldest, now - ticket.enqueuedAt);
  }
  return { queued, oldestWaitMs: oldest, busy5m: busyStamps.length };
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
  waiting.clear();
  busyStamps = [];
}

let upstreamWaitMsOverride = null;
/** How long a capped request may wait; 0 keeps the immediate account_busy. */
export function getUpstreamWaitMs() {
  if (upstreamWaitMsOverride !== null) return upstreamWaitMsOverride;
  const raw = Number(process.env.UPSTREAM_WAIT_MS);
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}
export function setUpstreamWaitMs(ms) {
  upstreamWaitMsOverride = Number.isInteger(ms) && ms >= 0 ? ms : null;
}
