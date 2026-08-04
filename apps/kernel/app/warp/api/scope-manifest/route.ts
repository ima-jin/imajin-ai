/**
 * GET + POST /warp/api/scope-manifest (#1428)
 *
 * Wires the shared scope-manifest route factory for the Warp connector
 * (static-secret ingestion). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed }. POST validates scopes fail-closed, publishes,
 * returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishWarpScopeManifest,
  readActiveWarpScopes,
  findWarpManifestAsset,
  warpKeySealed,
  VALID_WARP_SCOPES,
} from '@/src/lib/warp/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Warp',
  validScopes: VALID_WARP_SCOPES,
  findManifestAsset: findWarpManifestAsset,
  readActiveScopes: readActiveWarpScopes,
  publish: publishWarpScopeManifest,
  getExtraFields: async (ownerDid) => ({ keySealed: await warpKeySealed(ownerDid) }),
});
