/**
 * Write-ahead journal for the Postgres mirror (fork patch #8; docs/wavebot-patches.md).
 *
 * The mirror is best-effort: when Postgres is down the router must keep serving
 * from SQLite, so a failed mirror write cannot be allowed to fail the request.
 * But "best-effort" must not mean "silently lost" — a mirror that quietly drifts
 * from the source of truth is worse than no mirror, because dashboards and
 * quota checks read it.
 *
 * So each write group is appended to a local file and fsync'd BEFORE it is sent
 * to Postgres. The recovery rule is therefore simple and safe: a group that is
 * in the journal may or may not have reached Postgres, so replay it (every
 * statement is an upsert, which makes replay idempotent); a group that is not in
 * the journal never reached Postgres, because the append happens first.
 *
 * One JSON object per line keeps the file appendable and makes a torn tail
 * detectable: a partial line fails to parse, and the reader refuses the file
 * with its line number rather than replaying a truncated statement.
 */

import { openSync, closeSync, writeSync, fsyncSync, ftruncateSync, existsSync, readFileSync } from "node:fs";

export class JournalCorruptError extends Error {
  constructor(message, { line } = {}) {
    super(message);
    this.name = "JournalCorruptError";
    this.line = line;
  }
}

/**
 * Read and parse every group in the journal, in order.
 * A missing file is an empty journal, not an error.
 */
export function readJournal(filePath, fsImpl = { existsSync, readFileSync }) {
  if (!fsImpl.existsSync(filePath)) return [];
  const text = fsImpl.readFileSync(filePath, "utf8");
  const groups = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (!Array.isArray(parsed)) throw new Error("journal line is not an array");
      groups.push(parsed);
    } catch (err) {
      // 1-based line number: the operator greps the file with that number.
      throw new JournalCorruptError(`corrupt journal at line ${i + 1}: ${err.message}`, { line: i + 1 });
    }
  }
  return groups;
}

/**
 * @param {{ filePath: string, fsImpl?: object }} options
 */
export function createJournal({ filePath, fsImpl = null }) {
  const fs = fsImpl || { openSync, closeSync, writeSync, fsyncSync, ftruncateSync, existsSync, readFileSync };
  let fd = fs.openSync(filePath, "a");

  return {
    /** Durably append one transaction group. Returns only after the fsync. */
    append(group) {
      const line = `${JSON.stringify(group)}\n`;
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    },

    readAll() {
      return readJournal(filePath, fs);
    },

    /** Called once the journal has been fully replayed into Postgres. */
    truncate() {
      fs.ftruncateSync(fd, 0);
      fs.fsyncSync(fd);
    },

    close() {
      if (fd === null) return;
      fs.closeSync(fd);
      fd = null;
    },
  };
}
