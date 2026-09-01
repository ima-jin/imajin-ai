/**
 * GET + POST /xai/api/token (#1924)
 *
 * Pattern B credential ingestion for the xAI (Grok) connector, wired through
 * the shared token-paste route factory. A sealed `modelId` is how the owner
 * picks which Grok model runs — sealing a key IS choosing your brain. There is
 * no hardcoded default (#1769), so the model is chosen on the card via
 * `/xai/api/models`.
 *
 * Security invariants (enforced by the factory): the key is never logged,
 * never returned, never echoed, and per-DID isolation comes from
 * `xai-api-key:${ownerDid}`.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealApiKey, xaiKeySealed } from '@/src/lib/xai/connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'xAI',
  sealApiKey,
  keySealed: xaiKeySealed,
});
