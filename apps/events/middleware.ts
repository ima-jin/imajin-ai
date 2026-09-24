import { NextRequest, NextResponse } from "next/server";
import { standaloneDashboardMiddleware } from "@imajin/config";

/**
 * Standalone `/dashboard` -> hub tab redirect + `/api/:path*` CORS
 * pass-through (#2332, #1525). Body lives in `@imajin/config`'s
 * `standaloneDashboardMiddleware` — see its doc comment for why the
 * `matcher` below must stay a literal per app.
 */
export function middleware(request: NextRequest): NextResponse {
  return standaloneDashboardMiddleware(request, { service: "events" });
}

export const config = {
  matcher: [
    "/api/:path*",
    // Only fires when `embed` is absent, so the hub's iframe load
    // (`/dashboard?embed=hub&did=...`) never gets redirected (#2332).
    { source: "/dashboard", missing: [{ type: "query", key: "embed" }] },
  ],
};
