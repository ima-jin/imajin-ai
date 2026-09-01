/**
 * GET + POST /openai/api/token (#1927)
 *
 * Pattern B credential ingestion for the OpenAI connector, wired through the
 * shared token-paste route factory. A sealed `modelId` is how the owner picks
 * which OpenAI model runs — sealing a key IS choosing your brain. There is no
 * hardcoded default (#1769), so the model is chosen on the card via
 * `/openai/api/models`.
 *
 * Security invariants (enforced by the factory): the key is never logged,
 * never returned, never echoed, and per-DID isolation comes from
 * `openai-api-key:${ownerDid}`.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealApiKey, openaiKeySealed } from '@/src/lib/openai/connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'OpenAI',
  sealApiKey,
  keySealed: openaiKeySealed,
});
