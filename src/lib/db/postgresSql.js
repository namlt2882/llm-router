/**
 * SQLite → Postgres statement translation for the WaveBot mirror (fork patch #7;
 * docs/wavebot-patches.md).
 *
 * Why a translator and not a rewrite of the repos: the router's storage layer is
 * a sync SQLite adapter used all over the app. Rather than fork every call site,
 * the Postgres adapter mirrors each write to Postgres by translating the SQL the
 * SQLite layer already produced. That keeps one source of truth for the queries
 * and makes the mirror a thin, testable seam.
 *
 * The module is pure: no pg client, no env, no I/O. Everything that can be
 * wrong about a statement is decided here, where it can be tested.
 *
 * Two dialect differences matter:
 *   - `?` placeholders become `$1..$n`.
 *   - `INSERT OR REPLACE` / `INSERT OR IGNORE` have no Postgres spelling; they
 *     become `ON CONFLICT` clauses that need the table's primary key.
 *
 * Placeholders inside single-quoted string literals are NOT placeholders. The
 * scanner skips them so a `?` in data (a LIKE pattern, a URL) cannot shift every
 * binding after it — a failure that would corrupt rows silently rather than throw.
 */

export class PostgresTranslationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PostgresTranslationError";
    Object.assign(this, details);
  }
}

/**
 * Walk and split a statement, remembering whether each character is inside a
 * single-quoted literal ('' is an escaped quote inside one).
 */
function scan(sql, onPlaceholder) {
  let inString = false;
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "?") {
      n += 1;
      out += onPlaceholder ? onPlaceholder(n) : "?";
      continue;
    }
    out += ch;
  }
  return { out, count: n };
}

/** Count the bindable placeholders, ignoring any inside string literals. */
export function countPlaceholders(sql) {
  return scan(sql).count;
}

/**
 * Rewrite `?` to `$1..$n`. A count mismatch is a programming error in the
 * caller, not data: it throws rather than binding the wrong values.
 */
export function toPgPlaceholders(sql, paramCount) {
  const { out, count } = scan(sql, (i) => `$${i}`);
  if (count !== paramCount) {
    throw new PostgresTranslationError(
      `placeholder count mismatch: SQL has ${count}, caller bound ${paramCount}`,
      { found: count, expected: paramCount },
    );
  }
  return out;
}

const INSERT_HEAD = /^(\s*)INSERT(?:\s+OR\s+(REPLACE|IGNORE))?\s+INTO\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/i;
const RETURNING_TAIL = /\bRETURNING\b/i;

/**
 * Translate one write statement.
 *
 * @param {string} sql
 * @param {(table: string) => string[] | null} primaryKeyFor - the table's key
 *   columns, or null when the mirror does not know the table.
 */
export function translateWrite(sql, primaryKeyFor) {
  const match = INSERT_HEAD.exec(sql);
  if (!match) return toPgPlaceholders(sql, countPlaceholders(sql));

  const [, indent, modifier, table, columnList] = match;
  const columns = columnList.split(",").map((c) => c.trim()).filter(Boolean);

  // Normalise the head first: `INSERT OR REPLACE INTO` → `INSERT INTO`.
  const rest = sql.slice(match[0].length);
  const out = toPgPlaceholders(
    modifier ? `${indent}INSERT INTO ${table}(${columnList})${rest}` : sql,
    countPlaceholders(sql),
  );

  const upper = sql.toUpperCase();
  const hasConflict = upper.includes("ON CONFLICT");
  const conflictKey = primaryKeyFor ? primaryKeyFor(table) : null;

  let clause = "";
  if (hasConflict) {
    clause = "";
  } else if (!modifier) {
    // A plain INSERT must still be REPLAY-SAFE. The journal's recovery rule is
    // "a group that is in the journal may or may not have reached Postgres, so
    // replay it", which is only sound if running it twice is harmless. For
    // `INSERT INTO kv(scope, key, value)` a second run raises 23505 and boot
    // replay rethrows — the mirror refuses to start; for `usageHistory` (whose
    // id is a bigserial) it silently allocates a NEW id, so a double-counted
    // usage row lands in the mirror and the id ordering diverges from memory.
    // DO NOTHING is the right spelling: a replayed row is one this group
    // already wrote, so there is nothing to update.
    //
    // Only when the table's whole key is bound: an INSERT that lets Postgres
    // allocate the key can never conflict on it, and adding DO NOTHING there
    // would only hide a schema mismatch.
    if (conflictKey && conflictKey.length && conflictKey.every((k) => columns.includes(k))) {
      clause = " ON CONFLICT DO NOTHING";
    }
  } else if (modifier && modifier.toUpperCase() === "IGNORE") {
    clause = " ON CONFLICT DO NOTHING";
  } else if (modifier) {
    if (!conflictKey || conflictKey.length === 0) {
      throw new PostgresTranslationError(
        `INSERT OR REPLACE on "${table}" has no known primary key; add it to the mirror's key map`,
        { table },
      );
    }
    const keySet = new Set(conflictKey);
    const updatable = columns.filter((c) => !keySet.has(c));
    clause = updatable.length
      ? ` ON CONFLICT (${conflictKey.join(", ")}) DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(", ")}`
      : ` ON CONFLICT (${conflictKey.join(", ")}) DO NOTHING`;
  }

  if (!clause) return out;

  // ON CONFLICT must come BEFORE a RETURNING clause, never after it.
  const returning = RETURNING_TAIL.exec(out);
  if (!returning) return `${out}${clause}`;
  const at = returning.index;
  return `${out.slice(0, at).replace(/\s+$/, "")}${clause} ${out.slice(at)}`;
}

/** Normalise a bound value to the string Postgres' text/JSONB columns take. */
export function toPgValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return String(value);
}
