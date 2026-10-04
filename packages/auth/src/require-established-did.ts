import type { AuthResult, AuthError } from "./types";
import { requireAuth } from "./require-auth";
import { isEstablishedTier } from "./tiers";

/**
 * Require established DID authentication (keypair-based, fully onboarded).
 * Allows only established-or-higher tiers, as defined by the single tier
 * allowlist in `isEstablishedTier()`; rejects soft, preliminary, and any
 * missing or unknown tier (fail closed).
 */
export async function requireEstablishedDID(
  request: Request
): Promise<AuthResult | AuthError> {
  const authResult = await requireAuth(request);

  if ("error" in authResult) {
    return authResult;
  }

  // Non-string tiers can never match, so they fail closed before the lookup.
  const tier: unknown = authResult.identity.tier;
  if (typeof tier !== "string" || !isEstablishedTier(tier)) {
    return {
      error: "This action requires an established identity",
      status: 403,
    };
  }

  return authResult;
}
