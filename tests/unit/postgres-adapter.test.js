import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../../src/lib/db/adapters/postgresAdapter.js";
import { readJournal } from "../../src/lib/db/postgresJournal.js";

function fakeClient(initial = {}) {
  const tables = structuredClone(initial);
  const queries = [];
  return {
    tables, queries,
    async query(sql, params = []) {
      queries.push([sql, params]);
      if (/^SELECT \* FROM ([A-Za-z_]\w*)/.test(sql)) {
        const t = sql.match(/^SELECT \* FROM ([A-Za-z_]\w*)/)[1];
        return { rows: tables[t] ?? [] };
      }
      if (/information_schema\.columns/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

const dir = () => mkdtempSync(join(tmpdir(), "pgadapter-"));
const tables = () => ({
  _meta: [{ key: "schemaVersion", value: "2" }],
  settings: [],
  providerConnections: [{ id: "c1", provider: "openai", authType: "apiKey", name: "A", email: null, priority: 1, isActive: 1, data: "{}", createdAt: "t", updatedAt: "t" }],
  providerNodes: [], proxyPools: [], apiKeys: [], combos: [], kv: [], usageHistory: [], usageDaily: [], requestDetails: [],
});

let adapter;
afterEach(async () => { if (adapter) await adapter.close(); adapter = null; });

describe("postgres adapter", () => {
  it("loads every table into memory and serves reads without touching Postgres", async () => {
    const client = fakeClient(tables());
    adapter = await createPostgresAdapter({ connectionString: "postgres://x", dataDir: dir(), client });
    const before = client.queries.length;
    expect(adapter.get("SELECT * FROM providerConnections WHERE id = ?", ["c1"]).name).toBe("A");
    expect(adapter.all("SELECT * FROM _meta")).toEqual([{ key: "schemaVersion", value: "2" }]);
    expect(client.queries.length).toBe(before);
  });

  it("journals a write immediately and flushes it to Postgres in order", async () => {
    const client = fakeClient(tables());
    adapter = await createPostgresAdapter({ connectionString: "postgres://x", dataDir: dir(), client });
    adapter.run("UPDATE providerConnections SET name = ? WHERE id = ?", ["B", "c1"]);
    expect(adapter.get("SELECT * FROM providerConnections WHERE id = ?", ["c1"]).name).toBe("B");
    await adapter.flushNow();
    const writes = client.queries.filter(([sql]) => /^UPDATE/.test(sql));
    expect(writes).toEqual([["UPDATE providerConnections SET name = $1 WHERE id = $2", ["B", "c1"]]]);
  });

  it("groups a transaction into one journal line and rolls it back on throw", async () => {
    const client = fakeClient(tables());
    adapter = await createPostgresAdapter({ connectionString: "postgres://x", dataDir: dir(), client });
    adapter.transaction(() => {
      adapter.run("UPDATE providerConnections SET name = ? WHERE id = ?", ["B", "c1"]);
      adapter.run("UPDATE providerConnections SET name = ? WHERE id = ?", ["C", "c1"]);
    });
    expect(adapter.get("SELECT * FROM providerConnections WHERE id = ?", ["c1"]).name).toBe("C");
    expect(() => adapter.transaction(() => {
      adapter.run("UPDATE providerConnections SET name = ? WHERE id = ?", ["Z", "c1"]);
      throw new Error("boom");
    })).toThrow("boom");
    expect(adapter.get("SELECT * FROM providerConnections WHERE id = ?", ["c1"]).name).toBe("C");
  });

  it("replays a journal left by a killed process, then truncates it", async () => {
    const dataDir = dir();
    const journalPath = join(dataDir, "journal.jsonl");
    // Exactly what `run` appends: one line per transaction group, already
    // translated and already $n-numbered.
    writeFileSync(journalPath, JSON.stringify([
      { sql: "UPDATE providerConnections SET name = $1 WHERE id = $2", params: ["J", "c1"] },
    ]) + "\n");
    const client = fakeClient(tables());
    adapter = await createPostgresAdapter({ connectionString: "postgres://x", dataDir, client, journalPath });
    expect(client.queries).toContainEqual([
      "UPDATE providerConnections SET name = $1 WHERE id = $2", ["J", "c1"],
    ]);
    expect(readJournal(journalPath)).toEqual([]);
  });

  it("aborts the boot on a corrupt journal line instead of dropping state", async () => {
    const dataDir = dir();
    const journalPath = join(dataDir, "journal.jsonl");
    writeFileSync(journalPath, "not json\n");
    await expect(createPostgresAdapter({
      connectionString: "postgres://x", dataDir, journalPath, client: fakeClient(tables()),
    })).rejects.toThrow(/line 1/);
  });

  it("translates INSERT OR REPLACE through the primary key", async () => {
    const client = fakeClient(tables());
    adapter = await createPostgresAdapter({ connectionString: "postgres://x", dataDir: dir(), client });
    adapter.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)", ["s", "k", "v"]);
    await adapter.flushNow();
    // Each group is wrapped in BEGIN/COMMIT, so find the statement itself.
    const insert = client.queries.find(([sql]) => /^INSERT INTO kv/.test(sql));
    expect(insert[0]).toBe("INSERT INTO kv(scope, key, value) VALUES($1, $2, $3) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value");
    expect(insert[1]).toEqual(["s", "k", "v"]);
  });
});
