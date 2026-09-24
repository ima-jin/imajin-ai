/**
 * GET + POST /github/api/scope-manifest (#1352)
 *
 * Wires the shared scope-manifest route factory for the GitHub connector.
 * GET returns { manifestAssetId, activeScopes, validScopes, configSealed, tokenSealed, flow,
 * externalGrantClientCount }. `externalGrantClientCount` (#2308) is a COUNT ONLY of external
 * MCP/OAuth clients holding their own grant of a github:* scope — never the connector's own
 * grant, and never a per-grant listing (that belongs on #2288's Grants lane).
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
  countExternalGitHubScopeGrantees,
  VALID_GITHUB_SCOPES,
} from '@/src/lib/github/scope-manifest';
import { configField, oauthVaultField, readConfigFlow, vaultField } from '@/src/lib/github/connector';
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
    const [configStatus, oauthStatus, patStatus, flow, externalGrantClientCount] = await Promise.all([
      vaultFieldStatus(configField(ownerDid)),
      vaultFieldStatus(oauthVaultField(ownerDid)),
      vaultFieldStatus(vaultField(ownerDid)),
      // Which BYO path the owner configured (#1391) — the discriminator only,
      // never a config field, so nothing secret crosses the wire. Null until a
      // config is sealed and readable, which is exactly when the UI should keep
      // showing its default (device) mode selector.
      readConfigFlow(ownerDid).catch(() => null),
      // #2308: count of external MCP/OAuth clients (Claude, MCP Inspector, ...)
      // holding their OWN active grant of a github:* scope — never this
      // connector's own scope-manifest grantee. Degrades to 0 (not fatal)
      // rather than failing the whole card on a query hiccup, same posture as
      // `flow` above.
      countExternalGitHubScopeGrantees(ownerDid).catch(() => 0),
    ]);
    return {
      configSealed: configStatus === 'ready',
      tokenSealed: oauthStatus === 'ready' || patStatus === 'ready',
      credentialPending:
        configStatus === 'pending-grant' ||
        oauthStatus === 'pending-grant' ||
        patStatus === 'pending-grant',
      flow,
      externalGrantClientCount,
    };
  },
});
