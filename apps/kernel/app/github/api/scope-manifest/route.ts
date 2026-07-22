/**
 * GET + POST /github/api/scope-manifest (#1352)
 *
 * Wires the shared scope-manifest route factory for the GitHub connector.
 * GET returns { manifestAssetId, activeScopes, validScopes, configSealed, tokenSealed }.
 * POST validates scopes fail-closed, publishes, returns { published, assetId, activeScopes }.
 *
 * Scope materialisation:
 *   github:read    → silent      (active immediately after POST)
 *   github:write   → on-consent  (needs consent_grants row for did:imajin:github-connector)
 *   github:org     → on-consent  (same)
 *   github:actions → never       (never materialises)
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishGitHubScopeManifest,
  readActiveGitHubScopes,
  findGitHubManifestAsset,
  VALID_GITHUB_SCOPES,
} from '@/src/lib/github/scope-manifest';
import { configField, oauthVaultField, vaultField } from '@/src/lib/github/connector';
import { vaultFieldExists } from '@/src/lib/vault';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'GitHub',
  validScopes: VALID_GITHUB_SCOPES,
  findManifestAsset: findGitHubManifestAsset,
  readActiveScopes: readActiveGitHubScopes,
  publish: publishGitHubScopeManifest,
  // Token is satisfied by either the OAuth bundle or a PAT fallback (#1354 flag #3).
  getExtraFields: async (ownerDid) => {
    const [configSealed, oauthTokenSealed, patSealed] = await Promise.all([
      vaultFieldExists(configField(ownerDid)),
      vaultFieldExists(oauthVaultField(ownerDid)),
      vaultFieldExists(vaultField(ownerDid)),
    ]);
    return { configSealed, tokenSealed: oauthTokenSealed || patSealed };
  },
});
