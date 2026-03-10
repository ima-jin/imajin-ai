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

/** Cookie options for cross-subdomain sessions */
export function getSessionCookieOptions(isProduction: boolean) {
  return {
    name: getSessionCookieName(isProduction ? "prod" : "dev"),
    options: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "none" as const,
      path: "/",
      ...(isProduction ? { domain: ".imajin.ai" } : {}),
      maxAge: 60 * 60 * 24, // 24 hours
    },
  };
}
