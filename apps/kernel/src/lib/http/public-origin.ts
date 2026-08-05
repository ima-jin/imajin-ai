import type { NextRequest } from "next/server";

/**
 * Trusted public origin for browser-facing responses (login redirects, etc).
 *
 * The kernel runs behind Caddy, so `request.url` reports the INTERNAL proxy
 * target — `http://localhost:3000` (Next's fallback origin) even when the
 * process listens on :7000 and the browser arrived on
 * `https://jin.imajin.ai`. Redirecting off `request.url` therefore dead-ends
 * every unauthenticated browser at an unreachable `localhost` URL (#1608 for
 * the shared 401 helper; #1185 was the same bug in the MCP OAuth ceremony).
 *
 * Resolution order:
 *   1. `APP_URL` — a RUNTIME env var. Preferred: it is read on every request
 *      rather than inlined into the bundle at build time.
 *   2. `NEXT_PUBLIC_BASE_URL` — the existing node-root convention (see
 *      media/routes/access.ts, media/settle.ts). Build-time inlined by Next,
 *      so it silently resolves to `undefined` in a build that did not have it
 *      set — which is why (1) exists.
 *   3. `request.url`'s origin — correct for local dev, where the browser talks
 *      to the Next dev server directly with no proxy in front.
 *
 * Deliberately does NOT consult `Host` / `X-Forwarded-Host`. Those are
 * client-controlled, and trusting them to build a redirect origin turns every
 * 401 into a Host-header open redirect. A trusted env var has no such surface.
 */

/**
 * Normalise a configured base URL down to a bare origin, or null if unusable.
 *
 * Exported so the machine-readable discovery documents (`nodeUrl()`) normalise
 * configured origins exactly the same way this module's redirects do.
 */
export function toOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    // `.origin` strips any path (`.../chat`), trailing slash, and — critically —
    // guarantees we never carry a stale explicit port into the redirect. Mutating
    // `.host` on a parsed URL does NOT clear an existing port, which is how
    // `mcp.imajin.ai:3000` once leaked into a login `next=` (#1185).
    const { origin } = new URL(value);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** The origin browser-facing redirects should be anchored to. */
export function publicOrigin(request: NextRequest): string {
  return (
    toOrigin(process.env.APP_URL) ??
    toOrigin(process.env.NEXT_PUBLIC_BASE_URL) ??
    new URL(request.url).origin
  );
}
