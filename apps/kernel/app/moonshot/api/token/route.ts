/**
 * GET + POST /moonshot/api/token (#1930)
 *
 * Pattern B credential ingestion for the Moonshot connector, wired through
 * the shared token-paste route factory. A sealed `modelId` is how the owner
 * picks which Moonshot model runs — sealing a key IS choosing your brain.
 * There is no hardcoded default (#1769), so the model is chosen on the card
 * via `/moonshot/api/models`.
 *
 * Security invariants (enforced by the factory): the key is never logged,
 * never returned, never echoed, and per-DID isolation comes from
 * `moonshot-api-key:${ownerDid}`.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealApiKey, moonshotKeySealed } from '@/src/lib/moonshot/connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'Moonshot AI',
  sealApiKey,
  keySealed: moonshotKeySealed,
});
