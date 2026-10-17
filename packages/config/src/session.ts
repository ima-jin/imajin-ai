/**
 * Session cookie configuration — single source of truth.
 *
 * Every service that reads or writes the session cookie should import from here
 * instead of hardcoding 'imajin_session'.
 */

/** The session cookie name. Use a different name per environment to prevent collisions. */
export function getSessionCookieName(env?: "dev" | "prod"): string {
  // Auto-detect from common env vars if not specified
  const resolved =
    env ??
    (typeof process !== "undefined" && (process.env.IMAJIN_ENV === "dev" || process.env.NODE_ENV === "development")
      ? "dev"
      : "prod");

  return resolved === "dev" ? "imajin_session_dev" : "imajin_session";
}

/** Default cookie name — resolves at import time based on environment */
export const SESSION_COOKIE_NAME = getSessionCookieName();

/** Detect if running on localhost (not deployed to *.imajin.ai) */
function isLocalhost(): boolean {
  if (typeof process === "undefined") return false;
  const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX ?? "";
  return prefix.includes("localhost");
}

/**
 * Cookie domain scope (#1069 Phase 2).
 *
 * `SESSION_COOKIE_SCOPE` controls whether the deployed session cookie is a
 * shared parent-domain cookie or a host-only cookie:
 *   - unset / "host" (default): omit Domain; only the setting host receives it.
 *   - "domain": restore the legacy `.imajin.ai` scope for rollback.
 * Unknown values fail narrow. Same-origin path-proxied apps still receive
 * the cookie; see `docs/security/cookie-isolation.md` for the phase 3 gap.
 */
function isHostScoped(): boolean {
  return typeof process === "undefined" || process.env.SESSION_COOKIE_SCOPE !== "domain";
}

/** Cookie options for host-only sessions (with explicit domain rollback).
 *  When called with no argument, auto-detects from IMAJIN_ENV (same logic as getSessionCookieName).
 *  Accepts optional "dev" | "prod" override for explicit control.
 *
 *  Localhost-aware: when SERVICE_PREFIX contains "localhost", uses
 *  settings compatible with HTTP on localhost (no domain, not secure, lax sameSite).
 *
 *  `SESSION_COOKIE_SCOPE=domain` restores the deployed parent-domain cookie.
 */
export function getSessionCookieOptions(env?: "dev" | "prod") {
  const local = isLocalhost();
  const omitDomain = local || isHostScoped();
  return {
    name: getSessionCookieName(env),
    options: {
      httpOnly: true,
      secure: !local,
      sameSite: local ? ("lax" as const) : ("none" as const),
      path: "/",
      ...(omitDomain ? {} : { domain: ".imajin.ai" }),
      maxAge: 60 * 60 * 24, // 24 hours
    },
  };
}
