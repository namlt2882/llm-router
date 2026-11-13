import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JournalCorruptError, createJournal, readJournal } from "../../src/lib/db/postgresJournal.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "journal-")), "journal.jsonl");
const group = (n) => [{ sql: `INSERT INTO t(a) VALUES($1) /*${n}*/`, params: [n] }];

describe("journal", () => {
  it("round-trips groups in order", () => {
    const file = tmp();
    const j = createJournal({ filePath: file });
    j.append(group(1));
    j.append([...group(2), ...group(3)]);
    j.close();
    expect(readJournal(file)).toEqual([group(1), [...group(2), ...group(3)]]);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("fsyncs on append", async () => {
    const fsyncSync = vi.fn();
    const fsImpl = { ...await import("node:fs"), fsyncSync };
    const j = createJournal({ filePath: tmp(), fsImpl });
    j.append(group(1));
    expect(fsyncSync).toHaveBeenCalled();
    j.close();
  });

  it("truncate empties the file", () => {
    const file = tmp();
    const j = createJournal({ filePath: file });
    j.append(group(1));
    j.truncate();
    expect(readJournal(file)).toEqual([]);
    j.close();
  });

  it("refuses a corrupt line with its line number", () => {
    const file = tmp();
    writeFileSync(file, '[[{"sql":"a","params":[]}]]\nnot json\n');
    expect(() => readJournal(file)).toThrow(JournalCorruptError);
    expect(() => readJournal(file)).toThrow(/line 2/);
  });

  it("treats a missing journal as empty", () => {
    expect(readJournal("/nonexistent/journal.jsonl")).toEqual([]);
  });
});
