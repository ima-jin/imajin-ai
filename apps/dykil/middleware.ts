import { NextRequest, NextResponse } from "next/server";
import { buildPublicUrlAbsolute } from "@imajin/config";

/**
 * Redirect the standalone `/dashboard` page (`app/(chrome)/dashboard` — route
 * groups don't affect the public URL) to its hub tab equivalent (#2332,
 * carved out of #2275). Unconditional — the matcher below excludes the
 * embedded rendering path (`?embed=hub`) that `<ServiceEmbed>` loads inside
 * the hub's iframe (apps/kernel/app/auth/lib/service-registry.ts:
 * buildEmbedSrc), so this only ever fires for a direct, standalone visit.
 */
export function middleware(request: NextRequest) {
  const hubUrl = new URL(`${buildPublicUrlAbsolute("kernel")}/auth/dykil`);
  hubUrl.search = request.nextUrl.search;
  return NextResponse.redirect(hubUrl, 308);
}

export const config = {
  matcher: [
    // Only fires when `embed` is absent, so the hub's iframe load
    // (`/dashboard?embed=hub&did=...`) never gets redirected (#2332).
    { source: "/dashboard", missing: [{ type: "query", key: "embed" }] },
  ],
};
