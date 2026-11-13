/**
 * Postgres-backed mirror adapter (fork patch #9; docs/wavebot-patches.md).
 *
 * The router's storage layer is a SYNCHRONOUS SQLite adapter; every repo calls
 * `db.run/get/all/exec/transaction` and expects an answer before the next line.
 * Postgres over `pg` is asynchronous, so replacing SQLite outright would mean
 * rewriting every call site (and every repo test) — a fork we would then have to
 * re-apply on every upstream sync.
 *
 * So the shape is a mirror, not a replacement:
 *
 *   reads   → in-memory SQLite, loaded from Postgres at boot (sync, exact)
 *   writes  → in-memory SQLite synchronously, then the SAME statement is
 *             translated (postgresSql.js), appended to the fsync'd journal
 *             (postgresJournal.js) and flushed to Postgres in order
 *
 * What this buys: WaveBot can read the router's state from Postgres, and the
 * data survives a container restart even if the local volume is lost — because
 * the boot load reads Postgres, not SQLite on disk. What it costs: memory is
 * authoritative for the life of the process, so this is a single-writer design
 * (one router container). That is exactly the deployment shape (patch docs).
 *
 * Failure policy: a Postgres outage must never fail a request. A failed flush
 * keeps its groups in the journal and retries; it logs, it does not throw into
 * the request path. The one exclusion is boot, where an unreadable journal or an
 * unreachable database is a hard failure — starting with a mirror we cannot
 * trust is worse than not starting.
 */

import { DatabaseSync } from "node:sqlite";
import { TABLES, PRAGMA_SQL, buildCreateTableSql } from "../schema.js";
import { translateWrite, countPlaceholders } from "../postgresSql.js";
import { createJournal, readJournal } from "../postgresJournal.js";

/** Table → key columns. An upsert needs these; a missing entry is a hard error. */
export const PRIMARY_KEYS = {
  _meta: ["key"],
  settings: ["id"],
  providerConnections: ["id"],
  providerNodes: ["id"],
  proxyPools: ["id"],
  apiKeys: ["id"],
  combos: ["id"],
  kv: ["scope", "key"],
  usageHistory: ["id"],
  usageDaily: ["dateKey"],
  requestDetails: ["id"],
};

const primaryKeyFor = (table) => PRIMARY_KEYS[table] ?? null;

const TABLE_NAMES = Object.keys(TABLES);

/** Columns whose SQLite declaration is numeric — used to re-type rows on load. */
function isNumericColumn(table, column) {
  const decl = TABLES[table]?.columns?.[column] || "";
  return /INTEGER|REAL|NUMERIC/i.test(decl);
}

/** Mirror DDL: text everywhere, except the one auto-increment key. */
function buildPostgresTableSql(name) {
  const def = TABLES[name];
  const cols = Object.entries(def.columns).map(([col]) => {
    if (name === "usageHistory" && col === "id") return "id bigserial PRIMARY KEY";
    return `${col} text`;
  });
  const keys = PRIMARY_KEYS[name];
  if (keys && !(name === "usageHistory")) cols.push(`PRIMARY KEY (${keys.join(", ")})`);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}

/** Bind-safe scalar for pg: keep numbers numeric (bigint columns cast text badly). */
function pgParam(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

const isDdl = (sql) => /^\s*(CREATE|ALTER|DROP|PRAGMA)\b/i.test(sql);

export async function createPostgresAdapter({ connectionString, dataDir, client, journalPath }) {
  const pgClient = client || (await createPool(connectionString));
  const ownsClient = !client;
  const journalFile = journalPath || (dataDir ? `${dataDir}/journal.jsonl` : null);
  if (!journalFile) throw new Error("postgres adapter needs a dataDir or journalPath");

  const journal = createJournal({ filePath: journalFile });

  // ── 1. Mirror schema ────────────────────────────────────────────────────
  for (const name of TABLE_NAMES) {
    await pgClient.query(buildPostgresTableSql(name));
  }

  // ── 2. Replay whatever a killed process left behind, then truncate ──────
  // readJournal throws on a corrupt line: refuse to boot rather than silently
  // start a mirror that is missing writes we cannot identify.
  const leftover = readJournal(journalFile);
  for (const group of leftover) {
    await runGroup(pgClient, group);
  }
  if (leftover.length) {
    journal.truncate();
    // Replayed ids were explicit; move the serial sequence past them before
    // anything inserts a row without an id.
    await resyncSequences(pgClient);
  }

  // ── 3. In-memory SQLite, loaded from Postgres ───────────────────────────
  const mem = new DatabaseSync(":memory:");
  mem.exec(PRAGMA_SQL);
  for (const [name, def] of Object.entries(TABLES)) {
    mem.exec(buildCreateTableSql(name, def));
    for (const idx of def.indexes || []) mem.exec(idx);
  }

  for (const name of TABLE_NAMES) {
    const { rows } = await pgClient.query(`SELECT * FROM ${name}`);
    for (const row of rows || []) {
      const cols = Object.keys(row);
      const values = cols.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return null;
        if (isNumericColumn(name, c)) {
          const n = Number(v);
          return Number.isFinite(n) ? n : v;
        }
        return v;
      });
      if (!cols.length) continue;
      mem.prepare(`INSERT OR REPLACE INTO ${name}(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`)
        .run(...values);
    }
  }

  // ── 4. Write path ───────────────────────────────────────────────────────
  let pending = [];         // groups journaled but not yet confirmed in Postgres
  let openGroup = null;     // non-null inside transaction()
  let flushing = Promise.resolve();
  let closed = false;

  const appendGroup = (group) => {
    if (!group.length) return;
    journal.append(group);
    pending.push(group);
  };

  function scheduleFlush() {
    if (closed) return;
    flushing = flushing.then(() => flushOnce()).catch((err) => {
      // Never reject into the request path: the groups stay journaled and the
      // next write (or the next boot) retries them.
      console.warn(`[DB][pg] mirror flush failed, ${pending.length} group(s) journaled: ${err.message}`);
    });
  }

  async function flushOnce() {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    try {
      for (const group of batch) await runGroup(pgClient, group);
      journal.truncate();
    } catch (err) {
      pending = [...batch, ...pending];
      throw err;
    }
  }

  /** Explicit drain: awaits everything queued, and surfaces failures. */
  async function flushNow() {
    await flushing;
    await flushOnce();
    await flushing;
  }

  function runOnMemory(sql, params) {
    const stmt = mem.prepare(sql);
    const r = stmt.run(...params.map(pgParam));
    return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
  }

  return {
    driver: "postgres",

    run(sql, params = []) {
      const result = runOnMemory(sql, params);
      const statement = { sql: translateWrite(sql, primaryKeyFor), params: params.map(pgParam) };
      if (openGroup) openGroup.push(statement);
      else appendGroup([statement]);
      scheduleFlush();
      return result;
    },

    get(sql, params = []) {
      return mem.prepare(sql).get(...params.map(pgParam));
    },

    all(sql, params = []) {
      return mem.prepare(sql).all(...params.map(pgParam));
    },

    /**
     * DDL (migrations, PRAGMAs) runs on the memory database only. The mirror's
     * schema is owned by buildPostgresTableSql above — replaying SQLite DDL into
     * Postgres would fail on AUTOINCREMENT and rewrite the wrong thing.
     */
    exec(sql) {
      return mem.exec(sql);
    },

    transaction(fn) {
      const sp = `sp_${Math.random().toString(36).slice(2)}`;
      mem.exec(`SAVEPOINT ${sp}`);
      const previous = openGroup;
      const group = previous ? null : [];
      if (!previous) openGroup = group;
      try {
        const result = fn();
        mem.exec(`RELEASE ${sp}`);
        if (group) {
          openGroup = null;
          appendGroup(group);
          scheduleFlush();
        }
        return result;
      } catch (err) {
        try { mem.exec(`ROLLBACK TO ${sp}`); mem.exec(`RELEASE ${sp}`); } catch { /* already gone */ }
        if (group) openGroup = null;
        throw err;
      }
    },

    async syncMirrorSchemaFromTables() {
      for (const [name, def] of Object.entries(TABLES)) {
        const { rows } = await pgClient.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
          [name],
        );
        const existing = new Set((rows || []).map((r) => r.column_name ?? r.columnName));
        // A fake/partial client may report no columns at all; skip rather than
        // re-adding every column of an existing table on every boot.
        if (!existing.size) continue;
        for (const col of Object.keys(def.columns)) {
          if (!existing.has(col)) {
            await pgClient.query(`ALTER TABLE ${name} ADD COLUMN ${col} text`);
            console.log(`[DB][pg] +column ${name}.${col}`);
          }
        }
      }
      await resyncSequences(pgClient);
    },

    flushNow,

    async close() {
      if (closed) return;
      try { await flushNow(); } finally {
        closed = true;
        journal.close();
        try { mem.close(); } catch { /* already closed */ }
        if (ownsClient && typeof pgClient.end === "function") await pgClient.end();
      }
    },
  };
}

async function runGroup(client, group) {
  await client.query("BEGIN");
  try {
    for (const { sql, params } of group) await client.query(sql, params);
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection already dead */ }
    throw err;
  }
}

async function resyncSequences(client) {
  // Every mirrored id is explicit, so the sequence would otherwise start at 1
  // and collide the first time something inserts without an id.
  try {
    await client.query(
      "SELECT setval(pg_get_serial_sequence('usageHistory', 'id'), " +
      "COALESCE((SELECT MAX(id) FROM usageHistory), 1))",
    );
  } catch {
    // Table may not exist yet on a partial client; the next boot retries.
  }
}

async function createPool(connectionString) {
  const { default: pg } = await import("pg");
  return new pg.Pool({ connectionString, max: 4 });
}

/** Exported for tests that want to check the DDL without a database. */
export { buildPostgresTableSql, countPlaceholders };
