import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TABLES } from "../../src/lib/db/schema.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

function upSection(sql) {
  const i = sql.search(/^--\s*\+goose\s+Down/im);
  return i === -1 ? sql : sql.slice(0, i);
}

/** Split on commas that sit at parenthesis depth 0. */
function topLevelItems(body) {
  const items = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) items.push(cur);
  return items;
}

/** table -> Set(column), lower-cased, from CREATE TABLE and ALTER TABLE ... ADD COLUMN. */
export function columnsFromMigrations(sqlTexts) {
  const tables = new Map();
  for (const text of sqlTexts) {
    const up = upSection(text).replace(/--[^\n]*/g, "");
    for (const m of up.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\)\s*;/gi)) {
      const cols = new Set();
      for (const item of topLevelItems(m[2])) {
        const first = item.trim().split(/\s+/)[0];
        if (!first || /^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(first)) continue;
        cols.add(first.toLowerCase());
      }
      tables.set(m[1].toLowerCase(), cols);
    }
    for (const m of up.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)) {
      const t = m[1].toLowerCase();
      if (!tables.has(t)) tables.set(t, new Set());
      tables.get(t).add(m[2].toLowerCase());
    }
  }
  return tables;
}

/**
 * The mirror's column type contract. Every mirrored column is `text` (the
 * adapter re-types values on load: `isNumericColumn` reads the SQLite
 * declaration, not this copy), except the one auto-increment key, which has to
 * be a real sequence or an insert without an id would allocate nothing.
 *
 * A name-only diff cannot see this: `priority integer` is the same column as
 * `priority text` to a set of names, and the difference only shows up as a
 * value that comes back from Postgres as a number to a reader that trusts the
 * text contract, or as a failed `bigserial` insert.
 */
export function expectedMirrorType(table, column) {
  return table.toLowerCase() === "usagehistory" && column.toLowerCase() === "id" ? "bigserial" : "text";
}

/** table -> Map(column -> declared type), lower-cased, same sources as above. */
export function columnTypesFromMigrations(sqlTexts) {
  const out = new Map();
  for (const text of sqlTexts) {
    const up = upSection(text).replace(/--[^\n]*/g, "");
    const put = (table, column, type) => {
      const t = table.toLowerCase();
      if (!out.has(t)) out.set(t, new Map());
      out.get(t).set(column.toLowerCase(), type.toLowerCase());
    };
    for (const m of up.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\)\s*;/gi)) {
      for (const item of topLevelItems(m[2])) {
        const first = item.trim().split(/\s+/)[0];
        if (!first || /^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(first)) continue;
        // First word after the name; the rest is constraints (NOT NULL, DEFAULT,
        // PRIMARY KEY) and is not part of the mirror's type contract.
        const type = item.trim().split(/\s+/)[1] ?? "";
        put(m[1], first, type);
      }
    }
    for (const m of up.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+(\w+)/gi)) {
      put(m[1], m[2], m[3]);
    }
  }
  return out;
}

/** Index names a migration creates, lower-cased, from its Up section. */
export function indexesFromMigrations(sqlTexts) {
  const names = [];
  for (const text of sqlTexts) {
    const up = upSection(text).replace(/--[^\n]*/g, "");
    for (const m of up.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)) {
      names.push(m[1].toLowerCase());
    }
  }
  return names;
}

/** Index names declared in schema.js, lower-cased, read out of the CREATE INDEX text. */
export function declaredIndexes() {
  const names = [];
  for (const def of Object.values(TABLES)) {
    for (const sql of def.indexes || []) {
      const m = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
      if (m) names.push(m[1].toLowerCase());
    }
  }
  return names;
}

/** Human-readable differences between the declared schema and the migrations. */
export function diffAgainstTables(fromSql) {
  const out = [];
  const declared = new Map(Object.entries(TABLES).map(([t, d]) => [t.toLowerCase(), new Set(Object.keys(d.columns).map((c) => c.toLowerCase()))]));
  for (const [t, cols] of declared) {
    const have = fromSql.get(t);
    if (!have) { out.push(`table ${t} has no migration`); continue; }
    for (const c of cols) if (!have.has(c)) out.push(`${t}.${c} has no migration`);
    for (const c of have) if (!cols.has(c)) out.push(`${t}.${c} is not in schema.js`);
  }
  for (const t of fromSql.keys()) if (!declared.has(t)) out.push(`table ${t} is not in schema.js`);
  return out;
}

/** Differences between each mirrored column's declared type and the contract. */
export function diffTypesAgainstMirror(fromSql) {
  const out = [];
  for (const [t, types] of fromSql) {
    for (const [c, type] of types) {
      const want = expectedMirrorType(t, c);
      if (type !== want) out.push(`${t}.${c} is ${type}, the mirror contract says ${want}`);
    }
  }
  return out;
}


const files = () =>
  existsSync(MIGRATIONS)
    ? readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().map((f) => [f, readFileSync(join(MIGRATIONS, f), "utf8")])
    : [];

describe("goose migrations stay in step with schema.js", () => {
  it("every TABLES table and column is created by db/migrations, and nothing else", () => {
    const sqls = files();
    expect(sqls.length, "db/migrations must hold at least 001_baseline.sql").toBeGreaterThan(0);
    expect(diffAgainstTables(columnsFromMigrations(sqls.map(([, s]) => s)))).toEqual([]);
  });

  it("a TABLES column with no migration is reported", () => {
    const partial = "-- +goose Up\nCREATE TABLE combos (id text, name text);\n-- +goose Down\nDROP TABLE combos;";
    const diff = diffAgainstTables(columnsFromMigrations([partial]));
    expect(diff).toContain("combos.createdat has no migration");
    expect(diff).toContain("table settings has no migration");
  });

  it("an ADD COLUMN migration closes the gap, a Down section is ignored", () => {
    const base = "-- +goose Up\nCREATE TABLE combos (id text, name text);\n-- +goose Down\nALTER TABLE combos ADD COLUMN ghost text;";
    const alter = "-- +goose Up\nALTER TABLE combos ADD COLUMN kind text;";
    expect(columnsFromMigrations([base]).get("combos").has("ghost")).toBe(false);
    expect(columnsFromMigrations([base, alter]).get("combos").has("kind")).toBe(true);
  });

  it("usageHistory.id is bigserial and every other primary key matches the mirror", () => {
    const sql = files().map(([, s]) => s).join("\n");
    expect(sql).toMatch(/CREATE TABLE usageHistory\s*\([^;]*\bid bigserial PRIMARY KEY/i);
    expect(sql).toMatch(/CREATE TABLE kv\s*\([^;]*PRIMARY KEY \(scope, key\)/i);
    expect(sql).toMatch(/CREATE TABLE usageDaily\s*\([^;]*PRIMARY KEY \(dateKey\)/i);
    expect(sql).toMatch(/CREATE TABLE settings\s*\([^;]*PRIMARY KEY \(id\)/i);
  });

  // Names are not enough: `priority integer` and `priority text` are the same
  // column to a name-only diff, and both "pass". What breaks is the mirror's
  // value contract — the adapter re-types numerics from the SQLite declaration
  // and hands everything else through unchanged, so a migrated type that
  // disagrees with it returns numbers where the reader expects text (or the
  // reverse), and a usageHistory id that is not a sequence allocates nothing.
  it("every mirrored column is text, except usageHistory.id which is a sequence", () => {
    const sqls = files().map(([, s]) => s);
    expect(diffTypesAgainstMirror(columnTypesFromMigrations(sqls))).toEqual([]);
  });

  it("a migration that types a column differently is reported by name", () => {
    const wrong = "-- +goose Up\nCREATE TABLE providerConnections (id text, priority integer);";
    expect(diffTypesAgainstMirror(columnTypesFromMigrations([wrong]))).toContain(
      "providerconnections.priority is integer, the mirror contract says text",
    );
  });

  it("a text column is accepted, and the one key may be bigserial", () => {
    const ok = "-- +goose Up\nCREATE TABLE usageHistory (id bigserial PRIMARY KEY, provider text);\nCREATE TABLE combos (id text);";
    expect(diffTypesAgainstMirror(columnTypesFromMigrations([ok]))).toEqual([]);
  });

  it("an ADD COLUMN migration carries its type too", () => {
    const alter = "-- +goose Up\nALTER TABLE combos ADD COLUMN retries integer;";
    expect(diffTypesAgainstMirror(columnTypesFromMigrations([alter]))).toContain(
      "combos.retries is integer, the mirror contract says text",
    );
  });

  // The mirror is deliberately index-free: 001 reproduces the schema the router
  // used to build at boot, which had none, and the in-memory SQLite keeps the
  // indexes that make the reads fast. An index the migrations add is therefore
  // a decision — a Postgres-only index that no other check would ever compare
  // against anything — and it has to be declared in schema.js in the same
  // change, or the two schemas drift exactly where nothing looks.
  it("the mirror declares no index the rest of the schema does not", () => {
    const inMigrations = indexesFromMigrations(files().map(([, s]) => s));
    const declared = declaredIndexes();
    expect(inMigrations.filter((n) => !declared.includes(n))).toEqual([]);
    // Pinned: adding one here is a deliberate change, not drift that slipped in.
    expect(inMigrations).toEqual([]);
  });

  it("finds an index in both places when one is added", () => {
    const sqls = ["-- +goose Up\nCREATE UNIQUE INDEX IF NOT EXISTS idx_combo_name ON combos(name);"];
    expect(indexesFromMigrations(sqls)).toEqual(["idx_combo_name"]);
  });
});
