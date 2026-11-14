import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

async function load() {
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json: (body, init = {}) =>
        new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } }),
    },
  }));
  return import("@/app/api/fork/limits/route.js");
}

const req = (method, { token, body } = {}) =>
  new Request("http://router/api/fork/limits", {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function dropAdapter() {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
}

beforeEach(() => {
  dropAdapter();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-limits-"));
  process.env.DATA_DIR = tempDir;
  vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "secret-token");
  vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "5");
});

afterEach(() => {
  dropAdapter();
  vi.unstubAllEnvs();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("/api/fork/limits", () => {
  it("limits GET returns env default when no setting", async () => {
    const { GET } = await load();
    const res = await GET(req("GET", { token: "secret-token" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ account_max_inflight: 5, upstream_wait_ms: 0 });
  });

  it("limits PUT persists and survives a repo reload", async () => {
    let mod = await load();
    const put = await mod.PUT(req("PUT", { token: "secret-token", body: { account_max_inflight: 9, upstream_wait_ms: 15000 } }));
    expect(put.status).toBe(200);
    mod = await load(); // fresh module graph = fresh process state, same DATA_DIR
    const res = await mod.GET(req("GET", { token: "secret-token" }));
    expect(await res.json()).toEqual({ account_max_inflight: 9, upstream_wait_ms: 15000 });
  });

  it.each([
    [{ account_max_inflight: 0, upstream_wait_ms: 0 }],
    [{ account_max_inflight: 65, upstream_wait_ms: 0 }],
    [{ account_max_inflight: 4, upstream_wait_ms: 120001 }],
    [{ account_max_inflight: 4.5, upstream_wait_ms: 0 }],
    [{ account_max_inflight: 4 }],
  ])("limits PUT rejects %j with 400", async (body) => {
    const { PUT, GET } = await load();
    const res = await PUT(req("PUT", { token: "secret-token", body }));
    expect(res.status).toBe(400);
    const after = await GET(req("GET", { token: "secret-token" }));
    expect(await after.json()).toEqual({ account_max_inflight: 5, upstream_wait_ms: 0 });
  });

  it("limits rejects a request with no or wrong bearer with 401", async () => {
    const { GET, PUT } = await load();
    expect((await GET(req("GET"))).status).toBe(401);
    expect((await GET(req("GET", { token: "nope" }))).status).toBe(401);
    expect((await PUT(req("PUT", { token: "nope", body: { account_max_inflight: 2, upstream_wait_ms: 0 } }))).status).toBe(401);
  });

  it("bearer is rejected when WAVEBOT_FORK_ADMIN_TOKEN is unset", async () => {
    vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "");
    const { GET } = await load();
    expect((await GET(req("GET", { token: "" }))).status).toBe(401);
    expect((await GET(req("GET", { token: "undefined" }))).status).toBe(401);
  });
});
