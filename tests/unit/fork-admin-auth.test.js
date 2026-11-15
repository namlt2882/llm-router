import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

async function load() {
  vi.resetModules();
  const session = await import("@/lib/auth/dashboardSession");
  const { assertForkAdmin } = await import("@/lib/forkAdminAuth");
  return { assertForkAdmin, mint: session.createDashboardAuthToken };
}

const withCookie = (token) =>
  new Request("http://router/api/fork/limits", { headers: { cookie: `auth_token=${token}` } });

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-admin-"));
  process.env.DATA_DIR = tempDir;
  vi.stubEnv("JWT_SECRET", "test-secret-for-fork-admin");
  vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "secret-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("assertForkAdmin", () => {
  it("accepts the admin bearer", async () => {
    const { assertForkAdmin } = await load();
    const req = new Request("http://router/api/fork/limits", { headers: { authorization: "Bearer secret-token" } });
    expect(await assertForkAdmin(req)).toBe(true);
  });

  it("accepts a WaveBot ticket session", async () => {
    const { assertForkAdmin, mint } = await load();
    expect(await assertForkAdmin(withCookie(await mint({ via: "wavebot", sub: "u1" })))).toBe(true);
  });

  it("accepts the router's own password session", async () => {
    const { assertForkAdmin, mint } = await load();
    expect(await assertForkAdmin(withCookie(await mint()))).toBe(true);
  });

  it("refuses an OIDC session", async () => {
    const { assertForkAdmin, mint } = await load();
    expect(await assertForkAdmin(withCookie(await mint({ oidc: true, oidcSub: "x" })))).toBe(false);
  });

  it("refuses a SAML session", async () => {
    const { assertForkAdmin, mint } = await load();
    expect(await assertForkAdmin(withCookie(await mint({ saml: true, samlEmail: "a@b.c" })))).toBe(false);
  });

  it("refuses a forged cookie", async () => {
    const { assertForkAdmin } = await load();
    expect(await assertForkAdmin(withCookie("not.a.jwt"))).toBe(false);
  });
});
