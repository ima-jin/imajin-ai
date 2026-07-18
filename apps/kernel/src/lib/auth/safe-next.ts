/**
 * Same-origin `next=` redirect guard for the login flow.
 *
 * Extracted from app/auth/login/page.tsx so it can be unit-tested in isolation
 * (the page is a client component). Pure — no DOM/Next imports; the caller
 * passes the current origin.
 *
 * Accepts two shapes:
 *   1. A relative same-origin path (`/foo`, but NOT protocol-relative `//evil`).
 *   2. An ABSOLUTE URL whose origin equals `currentOrigin`.
 *
 * Shape (2) is required for the MCP OAuth round-trip: /oauth/authorize builds an
 * absolute `next=https://<public-origin>/oauth/authorize?...` (anchorToOrigin,
 * #1185) so the browser returns to the correct public origin after login behind
 * Caddy. A relative-only guard silently rejects that absolute next and dumps the
 * user on `/` instead of completing authorize→code→token — which surfaced as a
 * permanent `invalid_token` at /mcp for MCP Inspector (Day 170).
 */
export function isSafeNext(url: string | null, currentOrigin: string): url is string {
  if (typeof url !== 'string' || url.length === 0) return false;
  // (1) Relative same-origin path — reject protocol-relative `//host`.
  if (url.startsWith('/')) return !url.startsWith('//');
  // (2) Absolute URL — allow only if same-origin as the current page.
  try {
    return new URL(url).origin === currentOrigin;
  } catch {
    return false;
  }
}
