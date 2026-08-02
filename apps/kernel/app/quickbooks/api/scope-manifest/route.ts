/**
 * GET + POST /quickbooks/api/scope-manifest (#1356)
 *
 * Wires the shared scope-manifest route factory for the QuickBooks connector
 * (Pattern A — OAuth2). GET returns { manifestAssetId, activeScopes, validScopes,
 * configSealed, tokenSealed }. POST validates scopes fail-closed, publishes,
 * returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishQuickBooksScopeManifest,
  readActiveQuickBooksScopes,
  findQuickBooksManifestAsset,
  quickbooksConfigSealed,
  quickbooksTokenSealed,
  quickbooksCredentialPending,
  VALID_QUICKBOOKS_SCOPES,
} from '@/src/lib/quickbooks/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'QuickBooks',
  validScopes: VALID_QUICKBOOKS_SCOPES,
  findManifestAsset: findQuickBooksManifestAsset,
  readActiveScopes: readActiveQuickBooksScopes,
  publish: publishQuickBooksScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [configSealed, tokenSealed, credentialPending] = await Promise.all([
      quickbooksConfigSealed(ownerDid),
      quickbooksTokenSealed(ownerDid),
      quickbooksCredentialPending(ownerDid),
    ]);
    return { configSealed, tokenSealed, credentialPending };
  },
});
