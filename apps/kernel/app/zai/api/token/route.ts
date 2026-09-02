/**
 * GET + POST /zai/api/token (#1931)
 *
 * Pattern B credential ingestion for the Z.ai connector, wired through the
 * shared token-paste route factory. A sealed `modelId` is how the owner picks
 * which Z.ai (GLM) model runs — sealing a key IS choosing your brain. There
 * is no hardcoded default (#1769), so the model is chosen on the card via
 * `/zai/api/models`.
 *
 * Security invariants (enforced by the factory): the key is never logged,
 * never returned, never echoed, and per-DID isolation comes from
 * `zai-api-key:${ownerDid}`.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealApiKey, zaiKeySealed } from '@/src/lib/zai/connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'Z.ai',
  sealApiKey,
  keySealed: zaiKeySealed,
});
