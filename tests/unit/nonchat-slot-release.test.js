import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Fork patch #5 acquires a per-account in-flight slot inside
 * getProviderCredentials — for EVERY caller, not just chat. Only chatCore and
 * stream.js released it, so each image/TTS/STT/search/embeddings/fetch/video
 * call leaked one slot until the 10-minute TTL, and four such calls wedged the
 * account into `account_busy` (a 503 on everything that shares it).
 *
 * The behaviour is pinned handler-by-handler in the incremental tests; this
 * guard exists so the NEXT handler added cannot quietly reintroduce the leak.
 */

const ROOT = new URL("../../", import.meta.url).pathname;
// auth.js IS the acquirer. chat.js acquires and hands the credentials straight
// to handleChatCore, which owns every release path (including the synthesized
// bypass response) — the chat surface is pinned by the in-flight cap tests.
const SKIP = new Set(["src/sse/services/auth.js", "src/sse/handlers/chat.js"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // Build output and dependencies are not source: a `next build` (output:
      // "standalone") copies handler duplicates under src/.next/standalone/
      // and the audit then reads pre-fix copies that never release the slot —
      // one build after a green gate re-broke it (observed live 2026-11-17).
      if (entry === ".next" || entry === "node_modules") continue;
      walk(path, out);
    } else if (path.endsWith(".js")) out.push(path);
  }
  return out;
}

describe("every credential acquirer releases its in-flight slot", () => {
  it("a module that calls getProviderCredentials also releases the slot", () => {
    const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "open-sse"))]
      .filter((p) => !SKIP.has(relative(ROOT, p)));
    const acquirers = files.filter((p) => /\bgetProviderCredentials\s*\(/.test(readFileSync(p, "utf8")));
    expect(acquirers.length).toBeGreaterThan(5);

    const forgetting = acquirers
      .filter((p) => !/\breleaseAccountSlot\s*\(/.test(readFileSync(p, "utf8")))
      .map((p) => relative(ROOT, p));
    expect(forgetting).toEqual([]);
  });
});
