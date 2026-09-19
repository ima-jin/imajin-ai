/**
 * GET + POST /typesafe/api/scope-manifest (#2197)
 *
 * Wires the shared scope-manifest route factory for the TypeSafe.ai
 * connector (Pattern B — token-paste). GET returns { manifestAssetId,
 * activeScopes, validScopes, keySealed, credentialPending }. POST validates
 * scopes fail-closed, publishes, returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishTypesafeScopeManifest,
  readActiveTypesafeScopes,
  findTypesafeManifestAsset,
  typesafeKeySealed,
  typesafeKeyPending,
  VALID_TYPESAFE_SCOPES,
} from '@/src/lib/typesafe/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'TypeSafe.ai',
  validScopes: VALID_TYPESAFE_SCOPES,
  findManifestAsset: findTypesafeManifestAsset,
  readActiveScopes: readActiveTypesafeScopes,
  publish: publishTypesafeScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      typesafeKeySealed(ownerDid),
      typesafeKeyPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
