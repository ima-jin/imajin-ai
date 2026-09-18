/**
 * GET + POST /openrouter/api/token (#2188)
 *
 * Pattern B credential ingestion for the OpenRouter connector, wired through
 * the shared token-paste route factory. A sealed `modelId` is how the owner
 * picks which OpenRouter `provider/model` id runs (e.g. `typesafe/jev-1.13`)
 * — sealing a key IS choosing your brain. There is no hardcoded default
 * (#1769), so the model is chosen on the card via `/openrouter/api/models`.
 *
 * Security invariants (enforced by the factory): the key is never logged,
 * never returned, never echoed, and per-DID isolation comes from
 * `openrouter-api-key:${ownerDid}`.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealApiKey, openrouterKeySealed } from '@/src/lib/openrouter/connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'OpenRouter',
  sealApiKey,
  keySealed: openrouterKeySealed,
});
