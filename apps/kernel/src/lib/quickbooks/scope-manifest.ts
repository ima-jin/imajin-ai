/**
 * QuickBooks connector scope-manifest publisher (#1356).
 *
 * Thin wrapper over scope-manifest-core that supplies QuickBooks-specific
 * identity (connector DID, channel, scope descriptors, filenames). All generic
 * DB logic, consent-grant syncing, and publish orchestration live in the core.
 *
 * Scope release tiers (#1196 consent 2×2):
 *   quickbooks:read  → silent    (owner's own invoices; materialises on publish)
 *   quickbooks:write → on-consent (creates invoices touching customer records)
 */
import {
  buildConnectorManifestContent,
  findConnectorManifestAsset,
  readActiveConnectorScopes,
  syncConnectorConsentGrants,
  publishConnectorScopeManifest,
  type ConnectorScopeDescriptor,
  type Asset,
} from '@/src/lib/kernel/scope-manifest-core';
import { QUICKBOOKS_CONNECTOR_DID, configField, vaultField } from './connector';
import { vaultFieldExists } from '@/src/lib/vault';

// ── Scope registry ────────────────────────────────────────────────────────────

/** QuickBooks connector scopes with #1196 release classifications. */
export const QUICKBOOKS_SCOPE_DESCRIPTORS: Readonly<Record<string, ConnectorScopeDescriptor>> = {
  'quickbooks:read': {
    verb: 'read', surface: 'invoices',
    label: 'Read your QuickBooks invoices',
    // Owner reading their own invoice data — silent (freely projectable).
    release: { discloses_others: false, sensitive: false },
  },
  'quickbooks:write': {
    verb: 'write', surface: 'invoices',
    label: 'Create QuickBooks invoices',
    // Creating invoices is sent to customers (touches others) → on-consent.
    release: { discloses_others: true, sensitive: false, viewer: QUICKBOOKS_CONNECTOR_DID },
  },
};

export const VALID_QUICKBOOKS_SCOPES = Object.keys(QUICKBOOKS_SCOPE_DESCRIPTORS) as Array<
  keyof typeof QUICKBOOKS_SCOPE_DESCRIPTORS
>;

const MANIFEST_CHANNEL = 'quickbooks';

function quickbooksScopeReleaseClass(
  scopeName: string,
): 'silent' | 'on-consent' | 'owner-only' | 'never' {
  const desc = QUICKBOOKS_SCOPE_DESCRIPTORS[scopeName];
  if (!desc) return 'never';
  const r = desc.release;
  if (r.release) return r.release;
  if (!r.discloses_others && !r.sensitive) return 'silent';
  if (r.discloses_others && !r.sensitive) return 'on-consent';
  if (!r.discloses_others && r.sensitive) return 'owner-only';
  return 'never';
}

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
    (s) => quickbooksScopeReleaseClass(s) === 'on-consent',
  );
}

export function publishQuickBooksScopeManifest(ownerDid: string, scopes: readonly string[]): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: QUICKBOOKS_CONNECTOR_DID, channel: MANIFEST_CHANNEL,
    filename: 'quickbooks-scope-manifest.md', scopeDescriptors: QUICKBOOKS_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => quickbooksScopeReleaseClass(s) === 'on-consent',
  });
}

/** Check whether the QuickBooks OAuth App config is sealed for ownerDid. */
export function quickbooksConfigSealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(configField(ownerDid));
}

/** Check whether a QuickBooks OAuth token bundle is sealed for ownerDid. */
export function quickbooksTokenSealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(vaultField(ownerDid));
}
