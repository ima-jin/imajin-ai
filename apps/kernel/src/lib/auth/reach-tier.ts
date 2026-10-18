export type ReachGateTier = 'soft' | 'preliminary' | 'established';

const GATE_TIER_BY_IDENTITY_TIER: Readonly<Record<string, ReachGateTier>> = {
  soft: 'soft',
  preliminary: 'preliminary',
  hard: 'preliminary',
  established: 'established',
  steward: 'established',
  operator: 'established',
};

/** Unknown identity tiers never acquire admission through a caller-supplied label. */
export function gateTierForIdentityTier(tier: unknown): ReachGateTier | null {
  if (typeof tier !== 'string') return null;
  return Object.hasOwn(GATE_TIER_BY_IDENTITY_TIER, tier) ? GATE_TIER_BY_IDENTITY_TIER[tier] : null;
}
