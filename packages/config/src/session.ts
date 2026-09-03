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
 * Cookie domain scope (#1069 Phase 1).
 *
 * `SESSION_COOKIE_SCOPE` controls whether the deployed session cookie is a
 * shared parent-domain cookie or a host-only cookie:
 *   - unset / "domain" (default): current behavior — `domain: ".imajin.ai"`,
 *     readable by every `*.imajin.ai` subdomain. Nothing changes unless this
 *     is explicitly set.
 *   - "host": omit the `domain` attribute entirely, so the cookie is scoped
 *     to the exact host that set it and is NOT sent to other subdomains.
 *     Apps that relied on reading the shared cookie must adopt scoped app
 *     tokens first (see `requireSessionOrAppToken` in `@imajin/auth` and
 *     `docs/security/cookie-isolation.md`) before this is flipped for real.
 *
 * This flag is a primitive for the staged rollout described in
 * `docs/security/cookie-isolation.md` — flipping it is a separate, later
 * phase, not part of shipping the primitive itself.
 */
function isHostScoped(): boolean {
  if (typeof process === "undefined") return false;
  return process.env.SESSION_COOKIE_SCOPE === "host";
}

/** Cookie options for cross-subdomain sessions.
 *  When called with no argument, auto-detects from IMAJIN_ENV (same logic as getSessionCookieName).
 *  Accepts optional "dev" | "prod" override for explicit control.
 *
 *  Localhost-aware: when SERVICE_PREFIX contains "localhost", uses
 *  settings compatible with HTTP on localhost (no domain, not secure, lax sameSite).
 *
 *  See {@link isHostScoped} for the `SESSION_COOKIE_SCOPE=host` opt-in that
 *  narrows the deployed cookie to host-only instead of `.imajin.ai`.
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
