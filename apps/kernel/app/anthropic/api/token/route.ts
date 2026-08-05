/**
 * GET + POST /anthropic/api/token (#1621)
 *
 * Pattern B credential ingestion for the Anthropic connector, wired through the
 * shared token-paste route factory. A sealed `modelId` is how the owner picks
 * which Claude model runs — sealing a key IS choosing your brain.
 *
 * Security invariants (enforced by the factory): the key is never logged, never
 * returned, never echoed, and per-DID isolation comes from
 * `anthropic-api-key:${ownerDid}`.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealApiKey, anthropicKeySealed } from '@/src/lib/anthropic/connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'Anthropic',
  sealApiKey,
  keySealed: anthropicKeySealed,
});
