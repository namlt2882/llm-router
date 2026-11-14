import { describe, it, expect, vi } from "vitest";
import { verifyWavebotTicket } from "../../src/lib/auth/wavebotTicket.js";

const ok = (body, status = 200) => new Response(JSON.stringify(body), { status });

describe("verifyWavebotTicket", () => {
  it("returns the WaveBot claims on ok", async () => {
    const fetchImpl = vi.fn(async () => ok({ ok: true, userId: "u1", email: "e", name: "n" }));
    await expect(verifyWavebotTicket("t", { authUrl: "http://wb", fetchImpl }))
      .resolves.toEqual({ ok: true, userId: "u1", email: "e", name: "n" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://wb/api/llm-router/ticket/verify",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ ticket: "t" });
  });

  it("treats any non-2xx or ok:false as rejected", async () => {
    for (const res of [ok({ ok: false }, 401), ok({ ok: true }, 403), ok({}, 500)]) {
      await expect(
        verifyWavebotTicket("t", { authUrl: "http://wb", fetchImpl: async () => res }),
      ).resolves.toEqual({ ok: false, reason: "rejected" });
    }
  });

  it("never throws when WaveBot is unreachable", async () => {
    await expect(
      verifyWavebotTicket("t", {
        authUrl: "http://wb",
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("strips a trailing slash from the WaveBot URL and refuses an empty ticket", async () => {
    const fetchImpl = vi.fn(async () => ok({ ok: true, userId: "u1" }));
    await verifyWavebotTicket("t", { authUrl: "http://wb/", fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://wb/api/llm-router/ticket/verify");
    await expect(verifyWavebotTicket("", { authUrl: "http://wb", fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  // 5 s was enough for a warm route, but the verify endpoint is compiled
  // lazily by `next dev` on its first hit and a full rebuild took 5.4 s live —
  // WaveBot answered 200 *after* this abort fired, the exchange died with
  // `error=wavebot_ticket`, and the first click after every dashboard restart
  // failed. 15 s still caps a genuinely hung WaveBot.
  it("waits 15 s for WaveBot by default, and an explicit timeoutMs still wins", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    const fetchImpl = vi.fn(async () => ok({ ok: true, userId: "u1" }));
    try {
      await verifyWavebotTicket("t", { authUrl: "http://wb", fetchImpl });
      expect(spy).toHaveBeenLastCalledWith(15_000);
      await verifyWavebotTicket("t", { authUrl: "http://wb", fetchImpl, timeoutMs: 1234 });
      expect(spy).toHaveBeenLastCalledWith(1234);
    } finally {
      spy.mockRestore();
    }
  });
});
