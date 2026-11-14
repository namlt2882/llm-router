/**
 * WaveBot ticket exchange (fork patch; see docs/wavebot-patches.md #2).
 *
 * The router never stores a WaveBot password and never sees a WaveBot session.
 * WaveBot mints a 30 s single-use HMAC ticket and opens
 *   <router>/dashboard/auth/ticket?ticket=...
 * which hands it back to WaveBot's verify route. Only after WaveBot says yes
 * — signature, unused jti, still a system admin — does this router issue its
 * own `auth_token` cookie. The router trusts a ticket only because it re-asked
 * the minting service; it never decodes or validates one locally.
 *
 * Returns, never throws: a network failure is a login refusal, not a 500.
 */

/** Abort cap for the verify POST. 5 s was enough for a warm route, but
 *  `next dev` compiles the verify endpoint lazily on its first hit and a full
 *  rebuild took 5.4 s live (2026-11-14): WaveBot answered 200 *after* the
 *  abort fired, and the first "Open router dashboard" click after every
 *  dashboard restart died with `error=wavebot_ticket`. 15 s still caps a
 *  genuinely hung WaveBot; a production build answers in milliseconds. */
export const VERIFY_TIMEOUT_MS = 15_000;

/**
 * @param {string} ticket
 * @param {{ authUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, userId: string, email: string|null, name: string|null }
 *   | { ok: false, reason: "rejected" | "unreachable" }>}
 */
export async function verifyWavebotTicket(ticket, opts = {}) {
  const authUrl = (opts.authUrl ?? process.env.WAVEBOT_AUTH_URL ?? "").trim().replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;

  if (!authUrl || typeof ticket !== "string" || !ticket) {
    return { ok: false, reason: "rejected" };
  }

  let res;
  try {
    res = await fetchImpl(`${authUrl}/api/llm-router/ticket/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  if (!res.ok) return { ok: false, reason: "rejected" };

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "rejected" };
  }
  if (!body || body.ok !== true || typeof body.userId !== "string") {
    return { ok: false, reason: "rejected" };
  }
  return {
    ok: true,
    userId: body.userId,
    email: typeof body.email === "string" ? body.email : null,
    name: typeof body.name === "string" ? body.name : null,
  };
}

/** True when the deployment is WaveBot-gated (the only login door is the ticket). */
export function wavebotAuthMode() {
  return Boolean((process.env.WAVEBOT_AUTH_URL ?? "").trim());
}
