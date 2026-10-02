/**
 * scripts/lib/attestation-internal-api-key-grant.ts
 *
 * The one code path that grants the kernel's `ATTESTATION_INTERNAL_API_KEY`
 * shared secret (#2245) to a consumer DID. Shared by
 * `scripts/grant-attestation-internal-api-key.ts` (operator, one DID) and
 * `scripts/provision-service-bootstrap.mjs` (#2442, every service bootstrap
 * identity) so the two can never drift.
 *
 * Idempotent (see `grantInternalSecretTo`): a grantee that already holds an
 * active grant gets that grant's id back, no new row.
 *
 * Importing this module loads the kernel's vault + DB layer, so it needs the
 * kernel's env (`DATABASE_URL`, `AUTH_PRIVATE_KEY`, optional `VAULT_PATH`).
 */
import { grantInternalSecretTo } from '../../apps/kernel/src/lib/vault/index.js';

// Must match `ATTESTATION_INTERNAL_API_KEY_PURPOSE` in
// apps/kernel/src/lib/auth/require-internal-api-key.ts and the literal
// used by apps/corpus/src/lib/attestation-key.ts.
export const ATTESTATION_INTERNAL_API_KEY_PURPOSE = 'kernel.attestation-internal-api-key';

export type AttestationGrantOutcome = Awaited<ReturnType<typeof grantInternalSecretTo>>;

/**
 * Ensure `granteeDid` holds an active grant of the attestation internal API
 * key. `grantedBy` is the acting principal recorded on the grant's audit log
 * line — scripts have no session/identity of their own, so they name
 * themselves rather than impersonating a DID they don't hold the key for.
 */
export function ensureAttestationInternalApiKeyGrant(
  granteeDid: string,
  grantedBy: string,
): Promise<AttestationGrantOutcome> {
  return grantInternalSecretTo(ATTESTATION_INTERNAL_API_KEY_PURPOSE, granteeDid, grantedBy);
}
