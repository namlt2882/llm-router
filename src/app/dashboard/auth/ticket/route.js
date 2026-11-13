import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { verifyWavebotTicket } from "@/lib/auth/wavebotTicket";

/**
 * Ticket exchange (fork patch; docs/wavebot-patches.md #2).
 *
 * Reached from WaveBot's "Open router dashboard" button. The ticket in the
 * query string is handed straight back to WaveBot for verification; anything
 * short of a 200 from there lands on /login with an error, never on a 500.
 * This is the ONE /dashboard path the guard lets through without a cookie.
 */
export async function GET(request) {
  const url = new URL(request.url);
  const ticket = url.searchParams.get("ticket") || "";
  const result = await verifyWavebotTicket(ticket);

  if (!result.ok) {
    const target = new URL("/login?error=wavebot_ticket", url);
    return NextResponse.redirect(target);
  }

  const cookieStore = await cookies();
  await setDashboardAuthCookie(cookieStore, request, {
    via: "wavebot",
    sub: result.userId,
    email: result.email,
    name: result.name,
  });
  return NextResponse.redirect(new URL("/dashboard", url));
}
