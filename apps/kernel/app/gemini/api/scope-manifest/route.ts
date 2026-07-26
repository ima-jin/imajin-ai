/**
 * GET + POST /gemini/api/scope-manifest (#1432)
 *
 * Wires the shared scope-manifest route factory for the Gemini connector
 * (Pattern B — token-paste). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed }. POST validates scopes fail-closed, publishes,
 * returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishGeminiScopeManifest,
  readActiveGeminiScopes,
  findGeminiManifestAsset,
  geminiKeySealed,
  VALID_GEMINI_SCOPES,
} from '@/src/lib/gemini/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Gemini',
  validScopes: VALID_GEMINI_SCOPES,
  findManifestAsset: findGeminiManifestAsset,
  readActiveScopes: readActiveGeminiScopes,
  publish: publishGeminiScopeManifest,
  getExtraFields: async (ownerDid) => ({ keySealed: await geminiKeySealed(ownerDid) }),
});
