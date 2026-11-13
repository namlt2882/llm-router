import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../../src/lib/db/adapters/postgresAdapter.js";
import { readJournal } from "../../src/lib/db/postgresJournal.js";
import { TABLES } from "../../src/lib/db/schema.js";

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

  it("close() during a Postgres outage resolves and keeps the write in the journal", async () => {
    const dataDir = dir();
    const journalPath = join(dataDir, "journal.jsonl");
    const client = fakeClient(tables());
    const a = await createPostgresAdapter({
      connectionString: "postgres://x", dataDir, client, journalPath,
    });
    const realQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      if (/^(BEGIN|UPDATE|COMMIT|ROLLBACK)/.test(sql)) throw new Error("connect ECONNREFUSED");
      return realQuery(sql, params);
    };
    a.run("UPDATE providerConnections SET name = ? WHERE id = ?", ["B", "c1"]);

    await expect(a.close()).resolves.toBeUndefined();

    expect(readJournal(journalPath)).toHaveLength(1);
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

describe("postgres adapter mirror schema reconciliation", () => {
  // Postgres folds unquoted identifiers to lower case, so the mirror's own
  // table has `createdat`, not the `createdAt` the declared schema names.
  // Found live 2026-11-13: the second boot tried `ALTER TABLE combos ADD
  // COLUMN createdAt` every time, and because syncMirrorSchemaFromTables runs
  // inside the boot path the whole DB layer failed — every route answered
  // "column \"createdat\" of relation \"combos\" already exists".
  /** Reports `columns` for `combos` and every one of ITS declared columns
   *  for every other table — i.e. a mirror that is already in sync. */
  function clientWithColumns(columns) {
    const queries = [];
    return {
      queries,
      async query(sql, params = []) {
        queries.push([sql, params]);
        const info = sql.match(/information_schema\.columns[\s\S]*table_name = \$1/);
        if (info) {
          const tableName = params[0];
          const names = tableName === "combos"
            ? columns
            : Object.keys(TABLES[tableName]?.columns ?? {}).map((c) => c.toLowerCase());
          return { rows: names.map((column_name) => ({ column_name })) };
        }
        if (/^SELECT \* FROM ([A-Za-z_]\w*)/.test(sql)) return { rows: [] };
        return { rows: [] };
      },
    };
  }

  it("adds nothing when the existing table already has every declared column, case-folded", async () => {
    // Exactly what CREATE TABLE combos produces in Postgres.
    const columns = ["id", "name", "kind", "models", "createdat", "updatedat"];
    const client = clientWithColumns(columns);
    const adapter2 = await createPostgresAdapter({ connectionString: "postgres://x", dataDir: dir(), client });
    try {
      await adapter2.syncMirrorSchemaFromTables();
    } finally {
      await adapter2.close();
    }
    const alters = client.queries.filter(([sql]) => /^ALTER TABLE/i.test(sql));
    expect(alters).toEqual([]);
  });

  it("still adds a column the mirror does not have yet", async () => {
    const client = clientWithColumns(["id", "name"]);
    const adapter2 = await createPostgresAdapter({ connectionString: "postgres://x", dataDir: dir(), client });
    try {
      await adapter2.syncMirrorSchemaFromTables();
    } finally {
      await adapter2.close();
    }
    const alters = client.queries.filter(([sql]) => /^ALTER TABLE combos/i.test(sql)).map(([sql]) => sql);
    expect(alters).toHaveLength(4);
    expect(alters.every((sql) => / ADD COLUMN /.test(sql))).toBe(true);
  });
});

describe("postgres adapter durability under concurrency", () => {
  /** A client that holds the FIRST write group open so a second arrives mid-flush. */
  function gatedClient(initial, journalPath) {
    const tables = structuredClone(initial);
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    const queries = [];
    const seen = { began: 0, journalAtSecondBegin: null, inGate: null };
    let inserts = 0;
    return {
      tables, queries, seen, release: () => releaseGate(),
      async query(sql, params = []) {
        queries.push([sql, params]);
        if (/^BEGIN$/.test(sql.trim())) {
          seen.began += 1;
          // Second group's transaction: the first flush has already rewritten
          // the journal with whatever it had NOT confirmed. b must still be there.
          if (seen.began === 2) seen.journalAtSecondBegin = readJournal(journalPath);
        }
        if (/^SELECT \* FROM ([A-Za-z_]\w*)/.test(sql)) {
          return { rows: tables[sql.match(/^SELECT \* FROM ([A-Za-z_]\w*)/)[1]] ?? [] };
        }
        if (/information_schema\.columns/.test(sql)) return { rows: [] };
        if (/^INSERT INTO kv/.test(sql) && ++inserts === 1) {
          seen.inGate = new Promise((r) => { seen.gateReached = r; });
          await gate; // hold only the first group open
        }
        return { rows: [] };
      },
    };
  }

  it("keeps a group journaled while another flush is in flight", async () => {
    // The confirmed batch used to be dropped with a WHOLE-FILE truncate, so a
    // write that arrived while a flush awaited Postgres lost its durable copy
    // even though it was already acknowledged to the caller — the one guarantee
    // the mirror makes ("a crash loses nothing that was acknowledged").
    const dataDir = dir();
    const journalPath = join(dataDir, "journal.jsonl");
    const client = gatedClient(tables(), journalPath);
    adapter = await createPostgresAdapter({ connectionString: "postgres://x", dataDir, client, journalPath });

    adapter.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)", ["s", "a", "1"]);
    const flushing = adapter.flushNow();
    // Wait until the first group is genuinely in flight, then write the second.
    while (!client.seen.gateReached) await new Promise((r) => setTimeout(r, 1));
    adapter.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)", ["s", "b", "2"]);
    client.release();
    await flushing;

    // At the second group's BEGIN, the journal held exactly the unconfirmed
    // group: the acknowledged write that arrived mid-flush was never dropped.
    expect(client.seen.journalAtSecondBegin).toEqual([[
      {
        sql: "INSERT INTO kv(scope, key, value) VALUES($1, $2, $3) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
        params: ["s", "b", "2"],
      },
    ]]);
    // ...and once that group is confirmed too, the journal is empty.
    expect(readJournal(journalPath)).toEqual([]);
  });

  it("runs a group's BEGIN/COMMIT on one connection, never across a pool", async () => {
    // `pool.query` checks out an arbitrary connection per call, so BEGIN and
    // COMMIT can land on different sessions: the group either fails to commit
    // as a unit or commits statement-by-statement — a partial group that the
    // journal then drops, leaving Postgres permanently behind memory.
    const dataDir = dir();
    const journalPath = join(dataDir, "journal.jsonl");
    const tablesInitial = tables();

    const sessions = [];
    const pool = {
      // A pool's per-call query is a different connection each time.
      async query(sql) {
        if (/^SELECT \* FROM ([A-Za-z_]\w*)/.test(sql)) {
          return { rows: tablesInitial[sql.match(/^SELECT \* FROM ([A-Za-z_]\w*)/)[1]] ?? [] };
        }
        if (/information_schema\.columns/.test(sql)) return { rows: [] };
        return { rows: [] };
      },
      async connect() {
        const log = [];
        sessions.push(log);
        return {
          async query(sql) { log.push(sql.trim()); return { rows: [] }; },
          release() { log.push("<released>"); },
        };
      },
    };

    adapter = await createPostgresAdapter({ connectionString: "postgres://x", dataDir, client: pool, journalPath });
    adapter.transaction(() => {
      adapter.run("UPDATE providerConnections SET name = ? WHERE id = ?", ["B", "c1"]);
      adapter.run("UPDATE providerConnections SET name = ? WHERE id = ?", ["C", "c1"]);
    });
    await adapter.flushNow();

    expect(sessions).toHaveLength(1);
    expect(sessions[0][0]).toBe("BEGIN");
    expect(sessions[0]).toContain("UPDATE providerConnections SET name = $1 WHERE id = $2");
    expect(sessions[0][sessions[0].length - 2]).toBe("COMMIT");
    expect(sessions[0][sessions[0].length - 1]).toBe("<released>");
  });
});
