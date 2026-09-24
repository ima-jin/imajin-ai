/**
 * Per-tier upload byte limits, shared by POST /media/api/assets and
 * POST /media/api/assets/bundle (#2282) so both HTTP upload paths enforce the
 * same identity-tier ceiling from one place.
 */
export const TIER_LIMITS: Record<string, number> = {
  soft: 50,
  preliminary: 50,
  established: 200,
};

export function getUploadLimitBytes(identity: { tier?: string; uploadLimitMb?: number | null }): number {
  const mb = identity.uploadLimitMb ?? TIER_LIMITS[identity.tier || "soft"] ?? 50;
  return mb * 1024 * 1024;
}
