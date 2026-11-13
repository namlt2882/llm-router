import { describe, expect, it } from "vitest";
import { PostgresTranslationError, toPgPlaceholders, toPgValue, translateWrite } from "../../src/lib/db/postgresSql.js";

const PK = (t) => ({ kv: ["scope", "key"], apiKeys: ["id"], usageHistory: ["id"] }[t] ?? null);

describe("toPgPlaceholders", () => {
  it("numbers the placeholders", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?", 2)).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
  });
  it("throws on a count mismatch", () => {
    expect(() => toPgPlaceholders("SELECT ?", 2)).toThrow(PostgresTranslationError);
  });
});

describe("translateWrite", () => {
  it("turns INSERT OR REPLACE into an upsert over the primary key", () => {
    expect(translateWrite("INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)", PK))
      .toBe("INSERT INTO kv(scope, key, value) VALUES($1, $2, $3) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value");
  });
  it("turns INSERT OR IGNORE into DO NOTHING", () => {
    expect(translateWrite("INSERT OR IGNORE INTO apiKeys(id, key) VALUES(?, ?)", PK))
      .toBe("INSERT INTO apiKeys(id, key) VALUES($1, $2) ON CONFLICT DO NOTHING");
  });
  it("leaves an explicit ON CONFLICT clause alone", () => {
    const sql = "INSERT INTO apiKeys(id, key) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET key = excluded.key";
    expect(translateWrite(sql, PK)).toBe("INSERT INTO apiKeys(id, key) VALUES($1, $2) ON CONFLICT(id) DO UPDATE SET key = excluded.key");
  });
  it("passes UPDATE and DELETE through with numbered placeholders", () => {
    expect(translateWrite("UPDATE apiKeys SET key = ? WHERE id = ?", PK)).toBe("UPDATE apiKeys SET key = $1 WHERE id = $2");
    expect(translateWrite("DELETE FROM apiKeys WHERE id = ?", PK)).toBe("DELETE FROM apiKeys WHERE id = $1");
  });
  it("throws when an upsert target has no known primary key", () => {
    expect(() => translateWrite("INSERT OR REPLACE INTO mystery(a) VALUES(?)", PK)).toThrow(PostgresTranslationError);
  });
  it("drops every non-key column from the update list, and uses DO NOTHING when only keys remain", () => {
    expect(translateWrite("INSERT OR REPLACE INTO apiKeys(id) VALUES(?)", PK))
      .toBe("INSERT INTO apiKeys(id) VALUES($1) ON CONFLICT (id) DO NOTHING");
  });
});

describe("statement scanning", () => {
  it("does not count a ? inside a string literal as a placeholder", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE label = 'a?b' AND id = ?", 1))
      .toBe("SELECT * FROM t WHERE label = 'a?b' AND id = $1");
  });

  it("puts the ON CONFLICT clause before RETURNING, never after", () => {
    expect(translateWrite("INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?) RETURNING key", PK))
      .toBe("INSERT INTO kv(scope, key, value) VALUES($1, $2, $3) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value RETURNING key");
  });
});

describe("toPgValue", () => {
  it("normalises the bindable scalars", () => {
    expect(toPgValue(null)).toBeNull();
    expect(toPgValue(7)).toBe("7");
    expect(toPgValue(true)).toBe("1");
    expect(toPgValue("x")).toBe("x");
    expect(toPgValue(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
  });
});
