import type { Identity, AuthResult, AuthError } from "./types";
import { requireAuth } from "./require-auth";

/**
 * Require hard DID authentication (keypair-based identity).
 * Rejects soft DIDs (email-only registration).
 */
export async function requireHardDID(
  request: Request
): Promise<AuthResult | AuthError> {
  const authResult = await requireAuth(request);

  if ("error" in authResult) {
    return authResult;
  }

  if (authResult.identity.tier === "soft") {
    return {
      error: "This action requires a full identity (hard DID)",
      status: 403,
    };
  }

  return authResult;
}
