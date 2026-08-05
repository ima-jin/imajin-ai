/**
 * GET + POST /warp/api/scope-manifest (#1428)
 *
 * Wires the shared scope-manifest route factory for the Warp connector
 * (static-secret ingestion). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed, credentialPending }. POST validates scopes fail-closed,
 * publishes, returns { published, assetId, activeScopes }.
 *
 * `credentialPending` (#1603) is the Tier-1 state: the key is sealed but the
 * external owner agent has not issued the delegation grant yet, so dispatch fails
 * closed. Reporting only `keySealed` would render that as "not connected" and
 * invite the operator to re-paste a key that is already stored correctly.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishWarpScopeManifest,
  readActiveWarpScopes,
  findWarpManifestAsset,
  warpKeySealed,
  warpKeyPending,
  VALID_WARP_SCOPES,
} from '@/src/lib/warp/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Warp',
  validScopes: VALID_WARP_SCOPES,
  findManifestAsset: findWarpManifestAsset,
  readActiveScopes: readActiveWarpScopes,
  publish: publishWarpScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      warpKeySealed(ownerDid),
      warpKeyPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
