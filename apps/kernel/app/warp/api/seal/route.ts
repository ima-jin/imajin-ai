/**
 * GET + POST + DELETE /warp/api/seal (#1428)
 *
 * Credential ingestion for the Warp Cloud Agent connector, wired from the shared
 * static-secret route factory (#1439).
 *
 * POST   — seals the Warp Agent key as a v2 delegation-grant vault field for the
 *          session owner's DID and mints the grant to the Warp connector DID.
 *          Body `{ secret, expiresAt? }`. Re-posting rotates.
 * GET    — `{ secretSealed: boolean }`. Never returns the key.
 * DELETE — revokes the delegation grant, which kills dispatch immediately with
 *          no key rotation. This is the owner-facing revoke path; the generic
 *          `/api/vault/delegation/revoke` route is admin-only and matches on the
 *          node DID as subject, so it cannot revoke a per-DID connector grant.
 */
import { createConnectorStaticSecretRoutes } from '@/src/lib/kernel/connector-static-secret-route';
import { warpConnector } from '@/src/lib/warp/connector';

export const { GET, POST, DELETE, OPTIONS } = createConnectorStaticSecretRoutes({
  name: 'Warp',
  connector: warpConnector,
});
