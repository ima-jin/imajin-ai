/**
 * GET + POST /anthropic/api/scope-manifest (#1621)
 *
 * Wires the shared scope-manifest route factory for the Anthropic connector
 * (Pattern B — token-paste). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed, credentialPending }. POST validates scopes
 * fail-closed, publishes, returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishAnthropicScopeManifest,
  readActiveAnthropicScopes,
  findAnthropicManifestAsset,
  anthropicKeySealed,
  anthropicKeyPending,
  VALID_ANTHROPIC_SCOPES,
} from '@/src/lib/anthropic/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Anthropic',
  validScopes: VALID_ANTHROPIC_SCOPES,
  findManifestAsset: findAnthropicManifestAsset,
  readActiveScopes: readActiveAnthropicScopes,
  publish: publishAnthropicScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      anthropicKeySealed(ownerDid),
      anthropicKeyPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
