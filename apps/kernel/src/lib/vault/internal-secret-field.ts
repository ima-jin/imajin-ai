/**
 * Pure (no db / server imports) helpers for recognising `internal-secret:*`
 * vault fields. Split out of `internal-secret.ts` so client components (the
 * /admin/vault panel and Set dialog, #2452) and API route guards share the one
 * definition without pulling the server-only provisioning module into a bundle.
 */

/** Field-name prefix every self-provisioned internal secret lives under. */
export const INTERNAL_SECRET_FIELD_PREFIX = 'internal-secret:';

/** True when `field` is an `internal-secret:*` field (#2446 — rotation routes these specially). */
export function isInternalSecretField(field: string): boolean {
  return field.startsWith(INTERNAL_SECRET_FIELD_PREFIX) && field.length > INTERNAL_SECRET_FIELD_PREFIX.length;
}
