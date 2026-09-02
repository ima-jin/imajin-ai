/**
 * GET + POST /zai/api/scope-manifest (#1931)
 *
 * Wires the shared scope-manifest route factory for the Z.ai connector
 * (Pattern B — token-paste). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed, credentialPending }. POST validates scopes
 * fail-closed, publishes, returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishZaiScopeManifest,
  readActiveZaiScopes,
  findZaiManifestAsset,
  zaiKeySealed,
  zaiKeyPending,
  VALID_ZAI_SCOPES,
} from '@/src/lib/zai/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Z.ai',
  validScopes: VALID_ZAI_SCOPES,
  findManifestAsset: findZaiManifestAsset,
  readActiveScopes: readActiveZaiScopes,
  publish: publishZaiScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      zaiKeySealed(ownerDid),
      zaiKeyPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
