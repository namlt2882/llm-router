/**
 * WaveBot fork policy (docs/wavebot-patches.md): the router has exactly one
 * trusted client — the WaveBot deployment on the same compose network, which
 * performs all plan admission itself. `/v1` stays inside that network and the
 * dashboard is ticket-only, so the Endpoint page's exposure tools (Cloudflare
 * Tunnel, Tailscale) and the API-key manager have no role here: a tunnel would
 * publish the keyless `/v1` beyond the compose network. Flip to `true` only
 * when deploying 9Router standalone.
 */
export const SHOW_EXPOSURE_UI = false;
