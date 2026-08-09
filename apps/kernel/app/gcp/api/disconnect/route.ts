/**
 * POST + OPTIONS /gcp/api/disconnect (#1720)
 *
 * Revoke the sealed GCP service-account key's delegation grant for the
 * session owner, cutting off access immediately. The sealed key itself is
 * not deleted — the owner can re-grant by re-pasting the same key — but
 * every `kernel.vault_delegation_grants` row for `gcp-api-key:{ownerDid}` is
 * marked revoked and its wrapped key material erased, so nothing can unseal
 * it until a fresh grant exists.
 */
import { createConnectorTokenDisconnectRoute } from '@/src/lib/kernel/connector-token-route';
import { revokeApiKey } from '@/src/lib/gcp/connector';

export const { POST, OPTIONS } = createConnectorTokenDisconnectRoute({
  name: 'Google Cloud',
  revokeApiKey,
});
