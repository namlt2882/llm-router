/**
 * Fork patch #5: a handler that returns a live upstream stream still owns its
 * account slot until the stream ends. Releasing at return would let the next
 * request in while the transfer is in flight — the exact over-count the
 * semaphore exists to prevent (codex image generation returns an SSE body).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  tryAcquireAccountSlot,
  getInflightCount,
  releaseSlotWithBody,
  __resetAccountInflight,
} from "../../src/sse/services/accountInflight.js";

const streamOf = (chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

describe("releaseSlotWithBody", () => {
  beforeEach(() => __resetAccountInflight());

  it("keeps the slot held until the body is fully read", async () => {
    tryAcquireAccountSlot("conn-1", 4);
    const response = releaseSlotWithBody(
      new Response(streamOf([new Uint8Array([1]), new Uint8Array([2])])),
      "conn-1",
    );

    expect(getInflightCount("conn-1")).toBe(1);
    await response.arrayBuffer();
    expect(getInflightCount("conn-1")).toBe(0);
  });

  it("releases when the consumer cancels the stream", async () => {
    tryAcquireAccountSlot("conn-2", 4);
    const response = releaseSlotWithBody(
      new Response(new ReadableStream({ start() {} })),
      "conn-2",
    );

    expect(getInflightCount("conn-2")).toBe(1);
    await response.body.cancel();
    expect(getInflightCount("conn-2")).toBe(0);
  });

  it("releases immediately when there is no body to stream", () => {
    tryAcquireAccountSlot("conn-3", 4);
    const response = releaseSlotWithBody(new Response(null, { status: 204 }), "conn-3");

    expect(response.status).toBe(204);
    expect(getInflightCount("conn-3")).toBe(0);
  });

  it("preserves status and headers of the wrapped response", () => {
    tryAcquireAccountSlot("conn-4", 4);
    const response = releaseSlotWithBody(
      new Response(streamOf([]), { status: 201, headers: { "x-test": "1" } }),
      "conn-4",
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("1");
  });
});
