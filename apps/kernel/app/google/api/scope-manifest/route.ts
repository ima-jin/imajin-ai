/**
 * GET + POST /google/api/scope-manifest (#2144)
 *
 * Wires the shared scope-manifest route factory for the Google Workspace
 * connector. GET returns { manifestAssetId, activeScopes, validScopes,
 * configSealed, tokenSealed, credentialPending, flow }. POST validates scopes
 * fail-closed, publishes, returns { published, assetId, activeScopes }.
 *
 * All six v1 scopes materialise `owner-only` (see scope-manifest.ts) — active
 * immediately after POST, since the owner IS the consenting party for their
 * own sealed refresh token.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishGoogleScopeManifest,
  readActiveGoogleScopes,
  findGoogleManifestAsset,
  VALID_GOOGLE_SCOPES,
} from '@/src/lib/google/scope-manifest';
import { configField, oauthVaultField, readConfigFlow } from '@/src/lib/google/connector';
import { vaultFieldStatus } from '@/src/lib/vault';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Google',
  validScopes: VALID_GOOGLE_SCOPES,
  findManifestAsset: findGoogleManifestAsset,
  readActiveScopes: readActiveGoogleScopes,
  publish: publishGoogleScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [configStatus, tokenStatus, flow] = await Promise.all([
      vaultFieldStatus(configField(ownerDid)),
      vaultFieldStatus(oauthVaultField(ownerDid)),
      readConfigFlow(ownerDid).catch(() => null),
    ]);
    return {
      configSealed: configStatus === 'ready',
      tokenSealed: tokenStatus === 'ready',
      credentialPending: configStatus === 'pending-grant' || tokenStatus === 'pending-grant',
      flow,
    };
  },
});
