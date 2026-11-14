import crypto from "node:crypto";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sessionCookie(request) {
  const fromJar = request.cookies?.get?.("auth_token")?.value;
  if (fromJar) return fromJar;
  const header = request.headers.get("cookie") || "";
  const hit = header.split(";").map((p) => p.trim()).find((p) => p.startsWith("auth_token="));
  return hit ? decodeURIComponent(hit.slice("auth_token=".length)) : null;
}

/** Fork patch #18: bearer WAVEBOT_FORK_ADMIN_TOKEN (unset/empty never matches) or an admin ticket session. */
export async function assertForkAdmin(request) {
  const expected = (process.env.WAVEBOT_FORK_ADMIN_TOKEN ?? "").trim();
  const auth = request.headers.get("authorization") || "";
  if (expected && auth.startsWith("Bearer ") && safeEqual(auth.slice(7).trim(), expected)) return true;
  const token = sessionCookie(request);
  return token ? await verifyDashboardAuthToken(token) : false;
}
