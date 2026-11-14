import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";
import { SHOW_EXPOSURE_UI } from "../../src/lib/fork/exposureUi.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const endpointPage = readFileSync(
  path.join(repoRoot, "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js"),
  "utf8",
);

describe("WaveBot fork policy", () => {
  // /v1 is reachable only from the WaveBot compose network, whose single
  // client (the dashboard) performs all plan admission itself — quota,
  // concurrency and model unlock happen before a turn ever reaches the
  // router. A shared API key would be a second, weaker credential beside
  // that boundary, so the fork defaults it off (owner decision 2026-11-14,
  // overriding the original `requireApiKey: true` design line).
  it("does not require an API key by default", () => {
    expect(mergeWithDefaults({}).requireApiKey).toBe(false);
  });

  // The Endpoint page's exposure tools publish the endpoint beyond the
  // compose network — exactly what the WaveBot topology must not do. They
  // stay out of the UI entirely; flip SHOW_EXPOSURE_UI only when deploying
  // 9Router standalone.
  it("gates the tunnel, tailscale and API-key surfaces off", () => {
    expect(SHOW_EXPOSURE_UI).toBe(false);
    // three separate gates: the Tunnel+Tailscale rows, the post-row exposure
    // banners/option, and the API Keys card
    expect(endpointPage.split("SHOW_EXPOSURE_UI && (").length - 1).toBeGreaterThanOrEqual(3);
    for (const marker of ["Cloudflare Tunnel", "Tailscale", 'id="require-api-key"']) {
      expect(endpointPage).toContain(marker);
    }
  });
});
