import { SESSION_COOKIE_NAME } from "@imajin/config";
import type { Identity, AuthResult, AuthError } from "./types";

const getAuthUrl = () => process.env.AUTH_SERVICE_URL!;

export interface AuthOptions {
  verifyChain?: boolean; // If true, also verify the chain is valid (not just session)
}

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
      tier: data.tier || data.identity?.tier || "soft",
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
 * Validate that a caller is an active owner or admin controller of a group DID.
 * Uses the internal API to avoid recursive auth checks.
 */
async function validateActingAs(
  callerDid: string,
  groupDid: string
): Promise<boolean> {
  const authUrl = getAuthUrl();
  const internalApiKey = process.env.ATTESTATION_INTERNAL_API_KEY;
  if (!internalApiKey) {
    console.warn("[AUTH] ATTESTATION_INTERNAL_API_KEY not set — cannot validate act-as");
    return false;
  }
  try {
    const res = await fetch(
      `${authUrl}/api/groups/${encodeURIComponent(groupDid)}/controllers/${encodeURIComponent(callerDid)}`,
      {
        headers: { Authorization: `Bearer ${internalApiKey}` },
        cache: "no-store",
      }
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.valid === true && (data.role === "owner" || data.role === "admin");
  } catch (err) {
    console.error("[AUTH] Act-as validation failed:", err);
    return false;
  }
}

/**
 * Require authentication. Checks session cookie first, then Bearer token.
 * Also handles X-Acting-As header for group identity impersonation.
 *
 * Works with both `Request` and `NextRequest`.
 */
export async function requireAuth(
  request: Request,
  options?: AuthOptions
): Promise<AuthResult | AuthError> {
  // Try session cookie first
  const cookieHeader = request.headers.get("cookie");
  const sessionToken = extractSessionCookie(cookieHeader);

  let result: AuthResult | AuthError;
  if (sessionToken) {
    result = await validateSessionCookie(sessionToken);
  } else {
    // Fall back to Bearer token
    const auth = request.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      result = await validateBearerToken(auth.slice(7));
    } else {
      return { error: "Not authenticated", status: 401 };
    }
  }

  if (options?.verifyChain && "identity" in result && result.identity) {
    try {
      const chainRes = await fetch(
        `${getAuthUrl()}/api/identity/${encodeURIComponent(result.identity.id)}/verify`
      );
      if (!chainRes.ok) {
        result.identity.chainVerified = false;
      } else {
        const chainData = await chainRes.json();
        result.identity.chainVerified = chainData.chain?.valid ?? false;
      }
    } catch (err) {
      console.error("[AUTH] Chain verification failed:", err);
      result.identity.chainVerified = false;
    }
  }

  // Handle X-Acting-As header for group identity impersonation
  if ("identity" in result && result.identity) {
    const actingAs = request.headers.get("x-acting-as");
    if (actingAs) {
      const allowed = await validateActingAs(result.identity.id, actingAs);
      if (!allowed) {
        return { error: "Not authorized to act as this group", status: 403 };
      }
      result.identity.actingAs = actingAs;
    }
  }

  return result;
}
