/**
 * POST + OPTIONS /gemini/api/disconnect (#1720)
 *
 * Revoke the sealed Gemini API key's delegation grant for the session owner,
 * cutting off access immediately. The sealed key itself is not deleted — the
 * owner can re-grant by re-pasting the same key — but every
 * `kernel.vault_delegation_grants` row for `gemini-api-key:{ownerDid}` is
 * marked revoked and its wrapped key material erased, so nothing can unseal
 * it until a fresh grant exists.
 */
import { createConnectorTokenDisconnectRoute } from '@/src/lib/kernel/connector-token-route';
import { revokeApiKey } from '@/src/lib/gemini/connector';

export const { POST, OPTIONS } = createConnectorTokenDisconnectRoute({
  name: 'Gemini',
  revokeApiKey,
});
