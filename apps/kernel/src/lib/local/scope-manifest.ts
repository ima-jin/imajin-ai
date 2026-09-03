/**
 * Local connector scope-manifest publisher (#1957).
 *
 * Thin wrapper over scope-manifest-core, mirroring `moonshot/scope-manifest.ts`.
 * All generic DB logic, consent-grant syncing, and publish orchestration live
 * in the core module; only local-specific identity lives here.
 *
 * `local:infer` is `{ disclosesOthers: false, sensitive: true }` (see
 * `brainInferScope` in `@imajin/auth/scope-vocabulary`), so the #1196 2×2
 * derives `owner-only` — the owner-configured `baseUrl` is never released to
 * a third party, whether or not a bearer token backs it.
 *
 * `getExtraFields` on the route built from this module reports `keySealed`
 * as whether a `baseUrl` is CONFIGURED, not whether a bearer token is
 * sealed — see `connector.ts`'s header for why "no key" is `local`'s normal
 * resolved state and `baseUrl` is the actual readiness signal the
 * connector-card UI's existing `keySealed`-driven gating should key off.
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
import { LOCAL_CONNECTOR_DID, LOCAL_CHANNEL } from './connector';

const CONNECTOR = 'local' as const;

export const LOCAL_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_LOCAL_SCOPES = validScopesForConnector(CONNECTOR);

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    LOCAL_CONNECTOR_DID, LOCAL_CHANNEL, LOCAL_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findLocalManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, LOCAL_CONNECTOR_DID);
}

export function readActiveLocalScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, LOCAL_CHANNEL, LOCAL_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, LOCAL_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishLocalScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: LOCAL_CONNECTOR_DID, channel: LOCAL_CHANNEL,
    filename: 'local-scope-manifest.md', scopeDescriptors: LOCAL_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}
