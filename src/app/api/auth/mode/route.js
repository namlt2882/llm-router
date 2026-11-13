import { NextResponse } from "next/server";

/**
 * Public: which login door this deployment has (fork patch #3).
 * The login page asks before rendering a password form that would be refused.
 */
export async function GET() {
  return NextResponse.json(
    { wavebot: Boolean((process.env.WAVEBOT_AUTH_URL ?? "").trim()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
