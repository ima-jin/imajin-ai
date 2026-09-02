/**
 * GET + POST /moonshot/api/scope-manifest (#1930)
 *
 * Wires the shared scope-manifest route factory for the Moonshot connector
 * (Pattern B — token-paste). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed, credentialPending }. POST validates scopes
 * fail-closed, publishes, returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishMoonshotScopeManifest,
  readActiveMoonshotScopes,
  findMoonshotManifestAsset,
  moonshotKeySealed,
  moonshotKeyPending,
  VALID_MOONSHOT_SCOPES,
} from '@/src/lib/moonshot/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Moonshot AI',
  validScopes: VALID_MOONSHOT_SCOPES,
  findManifestAsset: findMoonshotManifestAsset,
  readActiveScopes: readActiveMoonshotScopes,
  publish: publishMoonshotScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      moonshotKeySealed(ownerDid),
      moonshotKeyPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
