/**
 * Pure URL helpers for the OAuth ceremony's browser-facing redirects.
 *
 * Kept dependency-free (no db / Next imports) so it is unit-testable and safe to
 * import from route handlers.
 */

/**
 * Re-anchor an internal request URL's path+query onto the PUBLIC origin.
 *
 * Behind Caddy, `request.url` is the internal proxy target (e.g.
 * http://localhost:3000 or :7000). Mutating `.host` on that URL does NOT clear
 * an existing explicit port (WHATWG URL semantics), which leaked
 * `mcp.imajin.ai:3000` into the login `next=` param and dead-ended the browser
 * (#1185). Rebuilding path+search onto the issuer origin drops any stale port
 * cleanly, while leaving query-string values (e.g. the client's own
 * localhost:6274 redirect_uri) untouched.
 */
export function anchorToOrigin(internalUrl: string, origin: string): string {
  const internal = new URL(internalUrl);
  return new URL(internal.pathname + internal.search, origin).toString();
}
