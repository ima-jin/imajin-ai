/**
 * QuickBooks connector scope-manifest publisher (#1356).
 *
 * Thin wrapper over scope-manifest-core that supplies QuickBooks-specific
 * identity (connector DID, channel, scope descriptors, filenames). All generic
 * DB logic, consent-grant syncing, and publish orchestration live in the core.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add a
 * scope to this connector, add one entry there; this module needs no edit.
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
import { QUICKBOOKS_CONNECTOR_DID, configField, vaultField } from './connector';
import { vaultFieldExists, vaultFieldStatus } from '@/src/lib/vault';
import { getPlatformDid } from '@/src/lib/kernel/connector-platform-did';

// ── Scope registry (derived — #1253) ───────────────────────────────────────

const CONNECTOR = 'quickbooks' as const;

export const QUICKBOOKS_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_QUICKBOOKS_SCOPES = validScopesForConnector(CONNECTOR);

const MANIFEST_CHANNEL = 'quickbooks';

// ── Public API (delegates to core) ───────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    QUICKBOOKS_CONNECTOR_DID, MANIFEST_CHANNEL, QUICKBOOKS_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findQuickBooksManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, QUICKBOOKS_CONNECTOR_DID);
}

export function readActiveQuickBooksScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MANIFEST_CHANNEL, QUICKBOOKS_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, QUICKBOOKS_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s),
  );
}

export function publishQuickBooksScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: QUICKBOOKS_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'quickbooks-scope-manifest.md', scopeDescriptors: QUICKBOOKS_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s),
  });
}

/**
 * Check whether a QuickBooks OAuth App config is USABLE for ownerDid — either
 * their own BYO-app config, or (#1775) the shared platform config that
 * `resolveConfigDidWithPlatformFallback` falls back to at connect-time. This
 * has to mirror that same fallback, or the "Connect QuickBooks Account" step
 * stays gated off (`Complete step 1 first`) for every user except whoever
 * configured the shared Intuit app, even though connect itself would succeed
 * for them via the platform DID.
 */
export async function quickbooksConfigSealed(ownerDid: string): Promise<boolean> {
  if (await vaultFieldExists(configField(ownerDid))) {
    return true;
  }
  const platformDid = getPlatformDid();
  if (!platformDid) {
    return false;
  }
  return vaultFieldExists(configField(platformDid));
}

/** Check whether a QuickBooks OAuth token bundle is sealed for ownerDid. */
export function quickbooksTokenSealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(vaultField(ownerDid));
}

/**
 * Check whether the QuickBooks config or token is sealed but awaiting owner
 * grant approval (Tier 1, no active delegation grant yet). Distinct from
 * `quickbooksConfigSealed`/`quickbooksTokenSealed`, which report `false` for
 * this state (see field-status.ts) — lets the scope-manifest surface render
 * "waiting for owner approval" instead of "not connected".
 */
export async function quickbooksCredentialPending(ownerDid: string): Promise<boolean> {
  const [configStatus, tokenStatus] = await Promise.all([
    vaultFieldStatus(configField(ownerDid)),
    vaultFieldStatus(vaultField(ownerDid)),
  ]);
  return configStatus === 'pending-grant' || tokenStatus === 'pending-grant';
}
