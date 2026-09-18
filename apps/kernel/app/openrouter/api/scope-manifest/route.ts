/**
 * GET + POST /openrouter/api/scope-manifest (#2188)
 *
 * Wires the shared scope-manifest route factory for the OpenRouter connector
 * (Pattern B — token-paste). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed, credentialPending }. POST validates scopes
 * fail-closed, publishes, returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishOpenrouterScopeManifest,
  readActiveOpenrouterScopes,
  findOpenrouterManifestAsset,
  openrouterKeySealed,
  openrouterKeyPending,
  VALID_OPENROUTER_SCOPES,
} from '@/src/lib/openrouter/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'OpenRouter',
  validScopes: VALID_OPENROUTER_SCOPES,
  findManifestAsset: findOpenrouterManifestAsset,
  readActiveScopes: readActiveOpenrouterScopes,
  publish: publishOpenrouterScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      openrouterKeySealed(ownerDid),
      openrouterKeyPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
