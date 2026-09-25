import { NextRequest, NextResponse } from "next/server";
import { buildPublicUrlAbsolute } from "./services";
import { corsHeaders, withCors } from "./cors";

export interface StandaloneDashboardMiddlewareOptions {
  /** Service name used to build the hub tab URL (`/auth/<service>`). */
  service: string;
  /**
   * Whether to also answer CORS preflight and stamp CORS headers on every
   * other request — matches the app's pre-existing `/api/:path*` CORS
   * middleware (#1525). Defaults to `true`; pass `false` for an app (e.g.
   * dykil) that never had one.
   */
  cors?: boolean;
}

/**
 * Shared standalone-dashboard-to-hub redirect body (#2332, carved out of
 * #2275), used by every userspace service app's `middleware.ts` so the
 * redirect + CORS pass-through logic isn't duplicated six times over.
 *
 * Each app still declares its own literal `export const config = { matcher:
 * [...] }` — Next.js statically extracts `matcher` from the middleware
 * file's AST at build time (see
 * `next/dist/build/analysis/extract-const-value.js`: it only understands
 * literal object/array/string/etc. expressions, not a function call or a
 * destructured import) — so the matcher itself can't be factored out here
 * without Next silently falling back to its default, unrestricted matcher.
 * Only the function *body* is shared.
 *
 * The redirect is unconditional: a 308 to `/auth/<service>`, preserving the
 * query string. The embedded rendering path `<ServiceEmbed>` loads
 * (`?embed=hub&did=...`, see `apps/kernel/app/auth/lib/service-registry.ts`'s
 * `buildEmbedSrc`) never reaches this function at all — it's excluded
 * declaratively by each app's `matcher.missing` clause.
 */
export function standaloneDashboardMiddleware(
  request: NextRequest,
  { service, cors = true }: StandaloneDashboardMiddlewareOptions,
): NextResponse {
  if (request.nextUrl.pathname === "/dashboard") {
    const hubUrl = new URL(`${buildPublicUrlAbsolute("kernel")}/auth/${service}`);
    hubUrl.search = request.nextUrl.search;
    return NextResponse.redirect(hubUrl, 308);
  }

  if (!cors) {
    return NextResponse.next();
  }

  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
  }

  return withCors(NextResponse.next(), request);
}
