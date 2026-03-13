import type { AuthResult, AuthError } from "./types";
import { requireAuth } from "./require-auth";

/**
 * Require established DID authentication (keypair-based, fully onboarded).
 * Rejects soft and preliminary DIDs.
 */
export async function requireEstablishedDID(
  request: Request
): Promise<AuthResult | AuthError> {
  const authResult = await requireAuth(request);

  if ("error" in authResult) {
    return authResult;
  }

  if (authResult.identity.tier === "soft" || authResult.identity.tier === "preliminary") {
    return {
      error: "This action requires an established identity",
      status: 403,
    };
  }

  return authResult;
}
