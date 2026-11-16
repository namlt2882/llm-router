import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/usageDb", () => ({ getConcurrencyChartData: async (period) => [{ label: "x", period }], getChartData: async () => [] }));
const { GET } = await import("@/app/api/usage/concurrency/route.js");

describe("GET /api/usage/concurrency", () => {
  it("serves the period through the repo and rejects unknown periods", async () => {
    const ok = await GET(new Request("http://router/api/usage/concurrency?period=7d"));
    expect(ok.status).toBe(200);
    expect((await ok.json())[0].period).toBe("7d");
    const bad = await GET(new Request("http://router/api/usage/concurrency?period=90d"));
    expect(bad.status).toBe(400);
  });
});
