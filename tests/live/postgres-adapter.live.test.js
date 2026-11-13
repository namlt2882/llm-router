import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

const url = process.env.LLM_ROUTER_DATABASE_URL;

describe.skipIf(!url)("postgres adapter (live)", () => {
  it("writes through to the real database", async () => {
    const { createPostgresAdapter } = await import("../../src/lib/db/adapters/postgresAdapter.js");
    const db = await createPostgresAdapter({
      connectionString: url,
      dataDir: mkdtempSync(join(tmpdir(), "live-")),
      journalPath: join(mkdtempSync(join(tmpdir(), "live-")), "journal.jsonl"),
    });
    const key = randomUUID();
    db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)", ["probe", key, "1"]);
    await db.flushNow();

    const probe = new pg.Client({ connectionString: url });
    await probe.connect();
    const row = await probe.query("SELECT value FROM kv WHERE scope = 'probe' AND key = $1", [key]);
    expect(row.rows[0]?.value).toBe("1");
    await probe.query("DELETE FROM kv WHERE scope = 'probe' AND key = $1", [key]);
    await probe.end();
    await db.close();
  });

  it("boots a second instance from the database, not from a local file", async () => {
    // The property the whole design exists for: a router container that lost
    // its volume still comes up with the right state.
    const { createPostgresAdapter } = await import("../../src/lib/db/adapters/postgresAdapter.js");
    const key = randomUUID();
    const first = await createPostgresAdapter({
      connectionString: url,
      journalPath: join(mkdtempSync(join(tmpdir(), "live-a-")), "journal.jsonl"),
    });
    first.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)", ["probe", key, "2"]);
    await first.close();

    const second = await createPostgresAdapter({
      connectionString: url,
      journalPath: join(mkdtempSync(join(tmpdir(), "live-b-")), "journal.jsonl"),
    });
    expect(second.get("SELECT value FROM kv WHERE scope = 'probe' AND key = ?", [key])?.value).toBe("2");

    const probe = new pg.Client({ connectionString: url });
    await probe.connect();
    await probe.query("DELETE FROM kv WHERE scope = 'probe' AND key = $1", [key]);
    await probe.end();
    await second.close();
  });
});
