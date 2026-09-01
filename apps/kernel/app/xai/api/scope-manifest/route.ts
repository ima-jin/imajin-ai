/**
 * GET + POST /xai/api/scope-manifest (#1924)
 *
 * Wires the shared scope-manifest route factory for the xAI connector
 * (Pattern B — token-paste). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed, credentialPending }. POST validates scopes
 * fail-closed, publishes, returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishXaiScopeManifest,
  readActiveXaiScopes,
  findXaiManifestAsset,
  xaiKeySealed,
  xaiKeyPending,
  VALID_XAI_SCOPES,
} from '@/src/lib/xai/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'xAI',
  validScopes: VALID_XAI_SCOPES,
  findManifestAsset: findXaiManifestAsset,
  readActiveScopes: readActiveXaiScopes,
  publish: publishXaiScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      xaiKeySealed(ownerDid),
      xaiKeyPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
