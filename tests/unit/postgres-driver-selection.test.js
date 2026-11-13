import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The driver keeps a module-level (global) singleton so Next's dev reload reuses
// one adapter. Each case needs a fresh module graph.
const freshDriver = async () => {
  vi.resetModules();
  global._dbAdapter = undefined;
  return import("../../src/lib/db/driver.js");
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  global._dbAdapter = undefined;
});

describe("driver selection", () => {
  it("does not fall back to SQLite when LLM_ROUTER_DATABASE_URL is set but unreachable", async () => {
    // The one failure this pins: serving from a local file while the operator
    // believes Postgres holds the data. The boot must fail loudly instead.
    vi.stubEnv("LLM_ROUTER_DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:1/nowhere");
    vi.stubEnv("LLM_ROUTER_JOURNAL_DIR", mkdtempSync(join(tmpdir(), "drv-")));
    const { getAdapter } = await freshDriver();
    // Assert the CAUSE, not just "it threw": any unrelated failure would also
    // throw, and only a connection failure proves the fallback was suppressed.
    const err = await getAdapter().then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(`${err.code || ""} ${err.message}`).toMatch(/ECONNREFUSED|connect|127\.0\.0\.1:1/i);
  }, 20_000);

  it("still resolves a SQLite driver when no router database is configured", async () => {
    vi.stubEnv("LLM_ROUTER_DATABASE_URL", "");
    vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "drv-sqlite-")));
    const { getAdapter } = await freshDriver();
    const adapter = await getAdapter();
    expect(adapter.driver).not.toBe("postgres");
    await adapter.close();
  }, 20_000);
});
