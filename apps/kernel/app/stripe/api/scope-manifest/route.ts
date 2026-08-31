/**
 * GET + POST /stripe/api/scope-manifest (#1785)
 *
 * Wires the shared scope-manifest route factory for the Stripe connector
 * (token-paste pattern). GET returns { manifestAssetId, activeScopes,
 * validScopes, keySealed, credentialPending }. POST validates scopes
 * fail-closed, publishes, returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishStripeScopeManifest,
  readActiveStripeScopes,
  findStripeManifestAsset,
  stripeKeySealed,
  stripeKeyPending,
  VALID_STRIPE_SCOPES,
} from '@/src/lib/stripe/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Stripe',
  validScopes: VALID_STRIPE_SCOPES,
  findManifestAsset: findStripeManifestAsset,
  readActiveScopes: readActiveStripeScopes,
  publish: publishStripeScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      stripeKeySealed(ownerDid),
      stripeKeyPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
