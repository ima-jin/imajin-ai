/**
 * POST + OPTIONS /xai/api/disconnect (#1924, #1720 pattern)
 *
 * Revoke the sealed xAI API key's delegation grant for the session owner,
 * cutting off access immediately. The sealed key itself is not deleted — the
 * owner can re-grant by re-pasting the same key — but every
 * `kernel.vault_delegation_grants` row for `xai-api-key:{ownerDid}` is marked
 * revoked and its wrapped key material erased, so nothing can unseal it until
 * a fresh grant exists. Every active `xai` `channel_links` row is swept too
 * (#1733), and the connector's registry row is marked revoked (#1924).
 */
import { createConnectorTokenDisconnectRoute } from '@/src/lib/kernel/connector-token-route';
import { revokeApiKey } from '@/src/lib/xai/connector';

export const { POST, OPTIONS } = createConnectorTokenDisconnectRoute({
  name: 'xAI',
  revokeApiKey,
});
