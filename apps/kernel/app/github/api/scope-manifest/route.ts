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
import { vaultFieldStatus } from '@/src/lib/vault';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'GitHub',
  validScopes: VALID_GITHUB_SCOPES,
  findManifestAsset: findGitHubManifestAsset,
  readActiveScopes: readActiveGitHubScopes,
  publish: publishGitHubScopeManifest,
  // Token is satisfied by either the OAuth bundle or a PAT fallback (#1354 flag #3).
  // credentialPending distinguishes "sealed but awaiting owner grant approval"
  // (Tier 1, #1521) from "not configured" — vaultFieldStatus reports 'ready' only
  // once a usable grant covers the field, so configSealed/tokenSealed stay false
  // while a grant is pending and credentialPending carries the reason why.
  getExtraFields: async (ownerDid) => {
    const [configStatus, oauthStatus, patStatus] = await Promise.all([
      vaultFieldStatus(configField(ownerDid)),
      vaultFieldStatus(oauthVaultField(ownerDid)),
      vaultFieldStatus(vaultField(ownerDid)),
    ]);
    return {
      configSealed: configStatus === 'ready',
      tokenSealed: oauthStatus === 'ready' || patStatus === 'ready',
      credentialPending:
        configStatus === 'pending-grant' ||
        oauthStatus === 'pending-grant' ||
        patStatus === 'pending-grant',
    };
  },
});
