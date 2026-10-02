import type { AuthResult, AuthError } from "./types";
import { requireAuth } from "./require-auth";
import type { IdentityTier } from "./tiers";

/** Explicit allowlist: established or higher. Anything else fails closed. */
const ESTABLISHED_TIERS: ReadonlySet<IdentityTier> = new Set<IdentityTier>([
  "established",
  "steward",
  "operator",
]);

/**
 * Require established DID authentication (keypair-based, fully onboarded).
 * Allows only established-or-higher tiers; rejects soft, preliminary, and any
 * missing or unknown tier (fail closed).
 */
export async function requireEstablishedDID(
  request: Request
): Promise<AuthResult | AuthError> {
  const authResult = await requireAuth(request);

  if ("error" in authResult) {
    return authResult;
  }

  const tier: unknown = authResult.identity.tier;
  if (typeof tier !== "string" || !ESTABLISHED_TIERS.has(tier as IdentityTier)) {
    return {
      error: "This action requires an established identity",
      status: 403,
    };
  }

  return authResult;
}
