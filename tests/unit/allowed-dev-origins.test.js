import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Regression guard for the dev stack's "page stuck on Loading...".
//
// The local stack runs `next dev`, and Next blocks its own `/_next` dev
// resources — every client chunk and the HMR socket — when the browser's
// Origin is not loopback (or in `allowedDevOrigins`). Reaching the dev router
// on a Tailscale/LAN name painted the app shell and then never hydrated, while
// `/login` itself still answered 200; the only signal was one server log line:
//   Blocked cross-origin request to Next.js dev resource ... from "xeon.…"
// Production serves a built app, where the check does not exist, so this is a
// dev-harness property — but it lives in the image's config, not the compose
// file, so it is pinned here.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = readFileSync(path.join(repoRoot, "next.config.mjs"), "utf8");

describe("the dev server can accept a configured Origin", () => {
  it("declares allowedDevOrigins on the Next config", () => {
    expect(config).toMatch(/^\s*allowedDevOrigins:/m);
  });

  // The list has to be operator-settable: a hostname is machine-specific, and
  // a hardcoded literal could only be changed by editing git in two places
  // (this file and the compose mirror).
  it("reads the list from ALLOWED_DEV_ORIGINS instead of hardcoding hostnames", () => {
    const m = config.match(/allowedDevOrigins:\s*([^\n]*)/);
    expect(m, "allowedDevOrigins not found in next.config.mjs").toBeTruthy();
    expect(m[1]).toMatch(/process\.env\.ALLOWED_DEV_ORIGINS/);
  });

  // Next throws on an empty-string entry, and `"".split(",")` is `[""]`, so an
  // unset variable must produce `[]` — the default is what keeps loopback-only
  // machines working with no configuration at all.
  it("an unset variable yields an empty list, never ['']", async () => {
    const { default: nextConfig } = await import("../../next.config.mjs");
    const unset = { ...process.env };
    delete unset.ALLOWED_DEV_ORIGINS;
    process.env = unset;
    const { default: reloaded } = await import("../../next.config.mjs?unset");
    expect(reloaded.allowedDevOrigins).toEqual([]);
    expect(nextConfig).toBeTruthy();
  });
});
