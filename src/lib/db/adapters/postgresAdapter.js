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

  // ── 2. Replay whatever a killed process left behind, then truncate ──────
  // readJournal throws on a corrupt line: refuse to boot rather than silently
  // start a mirror that is missing writes we cannot identify.
  const leftover = readJournal(journalFile);
  for (const group of leftover) {
    await runGroup(pgClient, group);
  }
  if (leftover.length) journal.truncate();
  // Mirrored ids are explicit, so the serial sequence never advances on its
  // own. Move it past every stored id at each boot, before anything inserts a
  // row without one. (Boot used to do this as a side effect of the schema sync.)
  await resyncSequences(pgClient);

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
      // Truncate only the PREFIX that was just confirmed. Draining the whole
      // file was a data-loss window: a write that arrived while this flush was
      // awaiting Postgres is already in `pending` (and already acknowledged to
      // its caller), and a whole-file truncate would delete its only durable
      // copy. Rewrite the remainder instead.
      journal.rewrite(pending);
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
     * schema is owned by goose (db/migrations) — replaying SQLite DDL into
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

    flushNow,

    async close() {
      if (closed) return;
      try {
        await flushNow();
      } catch (err) {
        // The journal already holds every unflushed group durably and replays
        // at the next boot; an outage must not turn shutdown into a throw.
        console.warn(`[DB] close: final flush failed, journal retained: ${err?.message ?? err}`);
      } finally {
        closed = true;
        journal.close();
        try { mem.close(); } catch { /* already closed */ }
        if (ownsClient && typeof pgClient.end === "function") await pgClient.end();
      }
    },
  };
}

/**
 * Run one write group as ONE transaction.
 *
 * A group must be all-or-nothing: the journal treats it as the unit of
 * durability, and `flushOnce` drops it once Postgres has it. `pool.query`
 * checks out an arbitrary connection per call, so BEGIN and COMMIT issued that
 * way can land on different sessions — Postgres then either rejects the
 * COMMIT or, worse, the statements commit one-per-connection with no
 * transaction at all. The surviving statements are then dropped from the
 * journal as if the group had been applied whole, and Postgres is permanently
 * behind memory. So a pool gets a dedicated connection for the group.
 */
async function runGroup(client, group) {
  let session = client;
  if (typeof client.connect === "function") session = await client.connect();
  try {
    await session.query("BEGIN");
    try {
      for (const { sql, params } of group) await session.query(sql, params);
      await session.query("COMMIT");
    } catch (err) {
      try { await session.query("ROLLBACK"); } catch { /* connection already dead */ }
      throw err;
    }
  } finally {
    if (session !== client && typeof session.release === "function") session.release();
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
export { countPlaceholders };
