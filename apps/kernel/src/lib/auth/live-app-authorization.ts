/** Null expiry means indefinite; an expiry at this instant is already expired. */
export function isLiveAppAuthorization(
  grant: { revokedAt?: Date | null; expiresAt?: Date | null },
  now = Date.now(),
): boolean {
  return !grant.revokedAt && (grant.expiresAt == null || grant.expiresAt.getTime() > now);
}
