/**
 * Stripe connector scope-manifest publisher (#1785).
 *
 * Thin wrapper over scope-manifest-core, same shape as
 * `gemini/scope-manifest.ts`. Scope release tiers are DERIVED from the
 * declarative vocabulary (#1253) — see `packages/auth/src/scope-vocabulary.ts`.
 * `stripe:events` is `{ disclosesOthers: false, sensitive: true }`, so the
 * 2×2 derives `owner-only`: the owner's own sealed restricted key is what
 * makes the events exist, and they are never released to a third party.
 */
import {
  buildConnectorManifestContent,
  findConnectorManifestAsset,
  readActiveConnectorScopes,
  syncConnectorConsentGrants,
  publishConnectorScopeManifest,
  type Asset,
} from '@/src/lib/kernel/scope-manifest-core';
import {
  connectorScopeDescriptors,
  validScopesForConnector,
  requiresConsentRow,
} from '@/src/lib/kernel/scope-projections';
import { stripeConnectorDid } from './connector';

export { keySealed as stripeKeySealed, keyPending as stripeKeyPending } from './connector';

const CONNECTOR = 'stripe' as const;

export const stripeScopeDescriptors = connectorScopeDescriptors(CONNECTOR);

export const validStripeScopes = validScopesForConnector(CONNECTOR);

const MANIFEST_CHANNEL = 'stripe';

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    stripeConnectorDid, MANIFEST_CHANNEL, stripeScopeDescriptors, selectedScopes,
  );
}

export function findStripeManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, stripeConnectorDid);
}

export function readActiveStripeScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MANIFEST_CHANNEL, stripeConnectorDid);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, stripeConnectorDid, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishStripeScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: stripeConnectorDid, channel: MANIFEST_CHANNEL,
    filename: 'stripe-scope-manifest.md', scopeDescriptors: stripeScopeDescriptors,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
