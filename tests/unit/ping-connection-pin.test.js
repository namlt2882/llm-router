import { afterEach, describe, expect, it, vi } from "vitest";

// Minor #1 (final review): the image probe pings through /v1/images/generations,
// whose credential selection normally picks ANY active connection of the
// provider — so a verdict measured on connection B's key could be stored under
// connection A. `pingModelByKind` must carry the pin header so the handler can
// hold itself to the pinned row (see image-combo-fanout's hard-pin case).

const db = vi.hoisted(() => ({
  getApiKeys: vi.fn(async () => [{ key: "sk-1", isActive: true }]),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "machine") }));

const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");

const captured = [];
const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
  captured.length = 0;
});

describe("pingModelByKind connection pin", () => {
  it("sends x-connection-id when a pin is given, and an image verdict shape back", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      captured.push({ url, headers: init?.headers });
      return new Response(JSON.stringify({ data: [{ url: "https://img" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const r = await pingModelByKind("openai/gpt-image-1", "image", "http://127.0.0.1:1", "conn-9");
    expect(r.ok).toBe(true);
    expect(captured[0].headers["x-connection-id"]).toBe("conn-9");
  });
  it("sends no pin header when none is given (existing callers unchanged)", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      captured.push({ url, headers: init?.headers });
      return new Response(JSON.stringify({ data: [{ url: "https://img" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await pingModelByKind("openai/gpt-image-1", "image", "http://127.0.0.1:1");
    expect(captured[0].headers["x-connection-id"]).toBeUndefined();
  });
});
