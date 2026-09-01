/**
 * GET + POST /openai/api/scope-manifest (#1927)
 *
 * Wires the shared scope-manifest route factory for the OpenAI connector
 * (Pattern B — token-paste). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed, credentialPending }. POST validates scopes
 * fail-closed, publishes, returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishOpenaiScopeManifest,
  readActiveOpenaiScopes,
  findOpenaiManifestAsset,
  openaiKeySealed,
  openaiKeyPending,
  VALID_OPENAI_SCOPES,
} from '@/src/lib/openai/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'OpenAI',
  validScopes: VALID_OPENAI_SCOPES,
  findManifestAsset: findOpenaiManifestAsset,
  readActiveScopes: readActiveOpenaiScopes,
  publish: publishOpenaiScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      openaiKeySealed(ownerDid),
      openaiKeyPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
