import { NextRequest, NextResponse } from "next/server";
import { publicOrigin } from "./public-origin";
import { agentCardUrl } from "./node-url";

/**
 * Shared route-response helpers for kernel HTTP routes.
 *
 * Centralises content-negotiation (HTML vs JSON) and the standard
 * auth/error response shapes (401 + WWW-Authenticate + login-redirect,
 * 403 JSON/HTML, 402 JSON/HTML) that were previously copy-pasted across
 * kernel route handlers. Extracted as part of the family-① Sonar sweep
 * (issue #1467).
 */

// ---------------------------------------------------------------------------
// Content negotiation
// ---------------------------------------------------------------------------

/** Returns true when the client signals it accepts HTML (i.e. a browser). */
export function wantsHtml(request: NextRequest): boolean {
  return request.headers.get("accept")?.includes("text/html") ?? false;
}

// ---------------------------------------------------------------------------
// HTML error page builder
// ---------------------------------------------------------------------------

/** Build a minimal dark-mode HTML error page for browser-negotiated responses. */
export function buildErrorHtml(title: string, message: string): string {
  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { max-width: 480px; padding: 2.5rem; border: 1px solid #222; border-radius: 12px; text-align: center; }
    h1 { font-size: 1.5rem; font-weight: 700; color: #fff; margin: 0 0 0.75rem; }
    p { color: #999; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Standard error responses
// ---------------------------------------------------------------------------

/**
 * 401 Unauthorized.
 *
 * - JSON clients: 401 with `WWW-Authenticate: Bearer`.
 * - HTML clients: 307 redirect to `/auth/login?next=<returnTo>`.
 *
 * The redirect is anchored to the TRUSTED PUBLIC origin, never `request.url`.
 * Behind Caddy the latter is Next's internal fallback origin, so browser share
 * links 307'd to an unreachable `https://localhost:3000/auth/login?next=...`
 * and dead-ended (#1608). See publicOrigin() for the resolution order.
 */
export function respondUnauthorized(
  request: NextRequest,
  returnTo?: string,
): NextResponse {
  if (wantsHtml(request)) {
    const next = returnTo ?? request.nextUrl.pathname;
    return NextResponse.redirect(
      new URL(
        `/auth/login?next=${encodeURIComponent(next)}`,
        publicOrigin(request),
      ),
    );
  }
  // `onboarding` (#1899): a stranger's agent hitting this with an unknown or
  // ungranted key has no prior docs to consult — the rejection itself must
  // teach it where the front door (the agent card) is.
  return NextResponse.json(
    { error: "Authentication required", onboarding: agentCardUrl() },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

/**
 * 403 Forbidden.
 *
 * - JSON clients: 403 `{ error: jsonError, reason? }` — `jsonError` defaults to
 *   `htmlMessage` when omitted.
 * - HTML clients: 403 styled error page using `htmlTitle` / `htmlMessage`.
 *
 * Keeping the HTML and JSON error text separate lets callers show a friendly
 * sentence in the browser while returning a terse machine-readable key via API.
 */
export function respondForbidden(
  request: NextRequest,
  htmlTitle = "Access Denied",
  htmlMessage = "You do not have permission to access this resource.",
  jsonError?: string,
  reason?: string,
): NextResponse {
  if (wantsHtml(request)) {
    return new NextResponse(buildErrorHtml(htmlTitle, htmlMessage), {
      status: 403,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const error = jsonError ?? htmlMessage;
  // `onboarding` (#1899) — see respondUnauthorized() above for why.
  return NextResponse.json(
    reason ? { error, reason, onboarding: agentCardUrl() } : { error, onboarding: agentCardUrl() },
    { status: 403 },
  );
}

/**
 * 402 Payment Required.
 *
 * - JSON clients: 402 with the provided body + headers.
 * - HTML clients: 402 styled error page.
 */
export function respondPaymentRequired(
  request: NextRequest,
  jsonBody: unknown,
  jsonHeaders?: Record<string, string>,
): NextResponse {
  if (wantsHtml(request)) {
    return new NextResponse(
      buildErrorHtml(
        "Payment Required",
        "This asset requires payment to unlock. Please use a compatible client to complete settlement.",
      ),
      { status: 402, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  return NextResponse.json(jsonBody, { status: 402, headers: jsonHeaders });
}
