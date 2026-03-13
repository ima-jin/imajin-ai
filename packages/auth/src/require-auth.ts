import { SESSION_COOKIE_NAME } from "@imajin/config";
import type { Identity, AuthResult, AuthError } from "./types";

const getAuthUrl = () => process.env.AUTH_SERVICE_URL!;

/**
 * Extract session cookie value from a cookie header string.
 */
function extractSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const match = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!match) return null;
  return match.split("=")[1] || null;
}

/**
 * Validate a session cookie against auth service.
 */
async function validateSessionCookie(
  token: string
): Promise<AuthResult | AuthError> {
  try {
    const response = await fetch(`${getAuthUrl()}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      cache: "no-store",
    });

    if (!response.ok) {
      return { error: "Invalid or expired session", status: 401 };
    }

    const data = await response.json();
    const identity: Identity = {
      id: data.did || data.identity?.did || data.identity?.id,
      type: data.type || data.identity?.type || "human",
      name: data.name || data.identity?.name,
      handle: data.handle || data.identity?.handle,
      tier: data.tier || data.identity?.tier || "hard",
    };

    if (!identity.id) {
      return { error: "Invalid session data", status: 401 };
    }

    return { identity };
  } catch (error) {
    console.error("[AUTH] Session validation failed:", error);
    return { error: "Auth service unavailable", status: 503 };
  }
}

/**
 * Validate a Bearer token against auth service.
 */
async function validateBearerToken(
  token: string
): Promise<AuthResult | AuthError> {
  try {
    const response = await fetch(`${getAuthUrl()}/api/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      return { error: "Invalid or expired token", status: 401 };
    }

    const data = await response.json();
    if (!data.valid || !data.identity) {
      return { error: "Invalid token", status: 401 };
    }

    return { identity: data.identity };
  } catch (error) {
    console.error("[AUTH] Token validation failed:", error);
    return { error: "Auth service unavailable", status: 503 };
  }
}

/**
 * Require authentication. Checks session cookie first, then Bearer token.
 *
 * Works with both `Request` and `NextRequest`.
 */
export async function requireAuth(
  request: Request
): Promise<AuthResult | AuthError> {
  // Try session cookie first
  const cookieHeader = request.headers.get("cookie");
  const sessionToken = extractSessionCookie(cookieHeader);
  if (sessionToken) {
    return validateSessionCookie(sessionToken);
  }

  // Fall back to Bearer token
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return validateBearerToken(auth.slice(7));
  }

  return { error: "Not authenticated", status: 401 };
}
