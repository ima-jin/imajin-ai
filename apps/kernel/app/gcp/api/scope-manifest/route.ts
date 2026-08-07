/**
 * GET + POST /gcp/api/scope-manifest (#1317)
 *
 * Wires the shared scope-manifest route factory for the Google Cloud connector
 * (Pattern B — token-paste). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed, credentialPending }. POST validates scopes
 * fail-closed, publishes, returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishGcpScopeManifest,
  readActiveGcpScopes,
  findGcpManifestAsset,
  gcpKeySealed,
  gcpKeyPending,
  VALID_GCP_SCOPES,
} from '@/src/lib/gcp/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Google Cloud',
  validScopes: VALID_GCP_SCOPES,
  findManifestAsset: findGcpManifestAsset,
  readActiveScopes: readActiveGcpScopes,
  publish: publishGcpScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      gcpKeySealed(ownerDid),
      gcpKeyPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
