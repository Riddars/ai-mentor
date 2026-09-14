import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, authEnabled, verifyAuthToken } from "@/lib/auth";

// The single gate for the panel: any request without a valid cookie is sent to
// the login page (API calls get 401). Only token-signature crypto runs here (no
// database) — whether the user still exists, is enabled and the session is not
// revoked is re-checked by getViewer in server code. Without AUTH_SECRET the
// service is open in development and closed in production.
export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Not cookie-gated: GitHub webhooks (HMAC signature), the liveness probe, the
  // simulation admin route (SIM_ADMIN_TOKEN) and the dev seed (its own check).
  if (
    pathname.startsWith("/api/github/") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/simulate/") ||
    pathname.startsWith("/api/dev/")
  ) {
    return NextResponse.next();
  }

  if (!authEnabled() && process.env.NODE_ENV === "development") {
    return NextResponse.next();
  }

  const viewer = await verifyAuthToken(request.cookies.get(AUTH_COOKIE)?.value);
  if (viewer) {
    if (pathname.startsWith("/admin") && viewer.role !== "head") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Требуется вход." }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon|login).*)"],
};
