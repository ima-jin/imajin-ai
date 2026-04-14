/**
 * Identity tier helpers.
 *
 * Tier progression: soft → preliminary → established
 * - soft: email-only, unverified
 * - preliminary: keypair-based, basic verification
 * - established: fully verified (MFA, attestations, etc.)
 */

export type IdentityTier = 'soft' | 'preliminary' | 'established';

/** True if the identity has completed at least basic verification (preliminary or established). */
export function isVerifiedTier(tier: string | undefined | null): boolean {
  return tier === 'preliminary' || tier === 'established';
}

/** True if the identity has completed full verification (established only). */
export function isEstablishedTier(tier: string | undefined | null): boolean {
  return tier === 'established';
}

/** Normalize legacy tier values. Maps 'hard' → 'preliminary'. */
export function normalizeTier(tier: string | undefined | null): IdentityTier {
  if (tier === 'hard') return 'preliminary';
  if (tier === 'established') return 'established';
  if (tier === 'preliminary') return 'preliminary';
  return 'soft';
}
