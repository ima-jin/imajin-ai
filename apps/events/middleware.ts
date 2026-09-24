import { NextRequest, NextResponse } from "next/server";
import { buildPublicUrlAbsolute, corsHeaders } from "@imajin/config";

/**
 * Redirect the standalone `/dashboard` page to its hub tab equivalent
 * (#2332, carved out of #2275). Unconditional — the matcher below excludes
 * the embedded rendering path (`?embed=hub`) that `<ServiceEmbed>` loads
 * inside the hub's iframe (apps/kernel/app/auth/lib/service-registry.ts:
 * buildEmbedSrc), so this only ever fires for a direct, standalone visit.
 */
function redirectDashboardToHub(request: NextRequest): NextResponse {
  const hubUrl = new URL(`${buildPublicUrlAbsolute("kernel")}/auth/events`);
  hubUrl.search = request.nextUrl.search;
  return NextResponse.redirect(hubUrl, 308);
}

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/dashboard") {
    return redirectDashboardToHub(request);
  }

  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
  }
  const response = NextResponse.next();
  const headers = corsHeaders(request);
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    // Only fires when `embed` is absent, so the hub's iframe load
    // (`/dashboard?embed=hub&did=...`) never gets redirected (#2332).
    { source: "/dashboard", missing: [{ type: "query", key: "embed" }] },
  ],
};
