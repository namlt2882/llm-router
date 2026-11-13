/**
 * Redirect origin for the ticket exchange (fork patch; docs/wavebot-patches.md).
 *
 * `request.url` carries the address the server is LISTENING on, and this
 * deployment binds `0.0.0.0`. Live 2026-11-13 the exchange answered
 * `location: http://0.0.0.0:20128/dashboard`, which no browser can follow, so
 * every successful login ended on a dead address. Prefer the Host header (that
 * is the address the client actually asked for), and fall back to the request
 * URL when Host is absent or is itself a wildcard bind address.
 */

const WILDCARD_HOSTS = new Set(["0.0.0.0", "[::]", "::"]);

function hostOf(hostHeader) {
  const host = String(hostHeader || "").trim();
  if (!host) return "";
  // Strip the port only to test for a wildcard bind; keep the original form.
  const withoutPort = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return WILDCARD_HOSTS.has(withoutPort) ? "" : host;
}

/** Absolute URL for `path`, on the origin the client used. */
export function loginLandingUrl(request, path) {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "") || "http";
  const host = hostOf(request.headers.get("host")) || url.host;
  return `${proto}://${host}${path}`;
}
