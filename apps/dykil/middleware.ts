import { NextRequest, NextResponse } from "next/server";
import { standaloneDashboardMiddleware } from "@imajin/config";

/**
 * Standalone `/dashboard` page (`app/(chrome)/dashboard` — route groups
 * don't affect the public URL) -> hub tab redirect (#2332). No CORS
 * handling — dykil never had any. Body lives in `@imajin/config`'s
 * `standaloneDashboardMiddleware` — see its doc comment for why the
 * `matcher` below must stay a literal per app.
 */
export function middleware(request: NextRequest): NextResponse {
  return standaloneDashboardMiddleware(request, { service: "dykil", cors: false });
}

export const config = {
  matcher: [
    // Only fires when `embed` is absent, so the hub's iframe load
    // (`/dashboard?embed=hub&did=...`) never gets redirected (#2332).
    { source: "/dashboard", missing: [{ type: "query", key: "embed" }] },
  ],
};
