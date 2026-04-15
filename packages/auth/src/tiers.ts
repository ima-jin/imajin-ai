/**
 * Identity tier helpers.
 *
 * Tier progression: soft → preliminary → established → steward → operator
 * - soft: email-only, unverified
 * - preliminary: keypair-based, basic verification
 * - established: fully verified (MFA, attestations, etc.)
 * - steward: trusted community steward
 * - operator: platform operator (full access)
 */

export type IdentityTier = 'soft' | 'preliminary' | 'established' | 'steward' | 'operator';

/** True if the identity has completed at least basic verification (preliminary or established). */
export function isVerifiedTier(tier: string | undefined | null): boolean {
  return tier === 'preliminary' || tier === 'established' || tier === 'steward' || tier === 'operator';
}

/** True if the identity has completed full verification (established only). */
export function isEstablishedTier(tier: string | undefined | null): boolean {
  return tier === 'established' || tier === 'steward' || tier === 'operator';
}

/** True if the identity is a steward or operator. */
export function isStewardTier(tier: string | undefined | null): boolean {
  return tier === 'steward' || tier === 'operator';
}

/** True if the identity is an operator. */
export function isOperatorTier(tier: string | undefined | null): boolean {
  return tier === 'operator';
}

/** Normalize legacy tier values. Maps 'hard' → 'preliminary'. */
export function normalizeTier(tier: string | undefined | null): IdentityTier {
  if (tier === 'hard') return 'preliminary';
  if (tier === 'established') return 'established';
  if (tier === 'preliminary') return 'preliminary';
  if (tier === 'steward') return 'steward';
  if (tier === 'operator') return 'operator';
  return 'soft';
}
