import { describe, it, expect } from "vitest";
import { loginLandingUrl } from "../../src/lib/auth/ticketOrigin.js";

/**
 * The exchange route's redirects must be absolute URLs on the address the
 * BROWSER used. `request.url` carries the bind address in this deployment
 * (`next dev --hostname 0.0.0.0`): live 2026-11-13 the route answered
 * `location: http://0.0.0.0:20128/dashboard`, which a real browser cannot
 * follow. Same reasoning as `originOf` in mimoLoginSession.js.
 */
describe("loginLandingUrl", () => {
  it("builds the redirect on the Host header, not the bind address", () => {
    const req = new Request("http://0.0.0.0:20128/dashboard/auth/ticket?ticket=t", {
      headers: { host: "router.wavelabs.example" },
    });
    expect(loginLandingUrl(req, "/dashboard")).toBe("http://router.wavelabs.example/dashboard");
  });

  it("honours the forwarding protocol so a TLS deployment does not redirect to http", () => {
    const req = new Request("http://0.0.0.0:20128/dashboard/auth/ticket?ticket=t", {
      headers: { host: "router.wavelabs.example", "x-forwarded-proto": "https" },
    });
    expect(loginLandingUrl(req, "/dashboard")).toBe("https://router.wavelabs.example/dashboard");
  });

  it("keeps a query string on the target path", () => {
    const req = new Request("http://0.0.0.0:20128/dashboard/auth/ticket?ticket=t", {
      headers: { host: "r.example" },
    });
    expect(loginLandingUrl(req, "/login?error=wavebot_ticket")).toBe(
      "http://r.example/login?error=wavebot_ticket",
    );
  });

  it("drops the bind-address Host when one is presented", () => {
    // Some runtimes put the listen address in Host. Redirecting there is the
    // same bug by another route, so it falls back to the request URL instead.
    const req = new Request("http://127.0.0.1:20128/dashboard/auth/ticket?ticket=t", {
      headers: { host: "0.0.0.0:20128" },
    });
    expect(loginLandingUrl(req, "/dashboard")).toBe("http://127.0.0.1:20128/dashboard");
  });
});
