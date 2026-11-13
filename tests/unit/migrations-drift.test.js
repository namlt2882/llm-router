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
    expect(sql).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
  });
});
