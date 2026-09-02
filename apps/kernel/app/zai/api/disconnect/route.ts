/**
 * POST + OPTIONS /zai/api/disconnect (#1931, #1720 pattern)
 *
 * Revoke the sealed Z.ai API key's delegation grant for the session owner,
 * cutting off access immediately. The sealed key itself is not deleted — the
 * owner can re-grant by re-pasting the same key — but every
 * `kernel.vault_delegation_grants` row for `zai-api-key:{ownerDid}` is marked
 * revoked and its wrapped key material erased, so nothing can unseal it until
 * a fresh grant exists. Every active `zai` `channel_links` row is swept too
 * (#1733), and the connector's registry row is marked revoked (#1924).
 */
import { createConnectorTokenDisconnectRoute } from '@/src/lib/kernel/connector-token-route';
import { revokeApiKey } from '@/src/lib/zai/connector';

export const { POST, OPTIONS } = createConnectorTokenDisconnectRoute({
  name: 'Z.ai',
  revokeApiKey,
});
