/**
 * GET + POST /gemini/api/token (#1432)
 *
 * Pattern B credential ingestion for the Gemini connector, wired through the
 * shared token-paste route factory (extracted in #1621 when Anthropic became the
 * second connector needing identical handlers).
 *
 * `baseUrl` and `modelId` remain optional; a sealed `modelId` is how the owner
 * picks which model runs. Omitting them falls back to the brain resolver's
 * defaults for this connector, not to env vars.
 *
 * Security invariants (enforced by the factory): the key is never logged, never
 * returned, never echoed, and per-DID isolation comes from
 * `gemini-api-key:${ownerDid}`.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealApiKey, geminiKeySealed } from '@/src/lib/gemini/connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'Gemini',
  sealApiKey,
  keySealed: geminiKeySealed,
});
