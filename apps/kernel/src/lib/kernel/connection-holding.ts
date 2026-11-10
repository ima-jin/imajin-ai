import { and, eq, isNull, or, type AnyColumn } from 'drizzle-orm';
import { db, orgConnectionMemberGrants, type ConnectorRow } from '@/src/db';

export type ConnectionPurpose = 'inference' | 'billing';
type ProviderRow = { provider: string; purpose?: ConnectionPurpose; upstreamBinding?: string | null };
type HeldRow = Pick<ConnectorRow, 'ownerDid'>;
type GrantedRow = HeldRow & Pick<ConnectorRow, 'id' | 'status' | 'revokedAt' | 'expiresAt'>;
type GrantReader = Pick<typeof db, 'select'>;

const HELD_PREFIX = 'org-held-';
const BILLING_SUFFIX = '-billing';
const UPSTREAM_PREFIX = 'app-upstream:';

/** Ownership never depends on identity scope, provenance, or provider spelling. */
export const isHeldBy = (row: HeldRow, did: string) => row.ownerDid === did;

/** A1 compatibility boundary. A2 replaces these legacy reads with columns only. */
export function connectorVendor(row: ProviderRow): string {
  const provider = row.provider.startsWith(HELD_PREFIX) ? row.provider.slice(HELD_PREFIX.length) : row.provider;
  return provider.endsWith(BILLING_SUFFIX) ? provider.slice(0, -BILLING_SUFFIX.length) : provider;
}

export function connectorPurpose(row: ProviderRow): ConnectionPurpose {
  return row.purpose ?? (row.provider.endsWith(BILLING_SUFFIX) ? 'billing' : 'inference');
}

/** Legacy upstream selectors are opaque: they cannot attest a vendor or binding. */
export function isUpstreamConnection(row: ProviderRow): boolean {
  return !!row.upstreamBinding || row.provider.startsWith(UPSTREAM_PREFIX);
}

/** All legacy spelling expansion lives here until the A2 in-place migration. */
export function connectionProviderNames(vendor: string, purpose: ConnectionPurpose = 'inference'): string[] {
  const provider = purpose === 'billing' ? `${vendor}${BILLING_SUFFIX}` : vendor;
  return [provider, `${HELD_PREFIX}${provider}`];
}

export function connectionProviderCondition(column: AnyColumn, vendor: string, purpose: ConnectionPurpose = 'inference') {
  return or(...connectionProviderNames(vendor, purpose).map(provider => eq(column, provider)));
}

/** A1 writers retain billing storage identity until purpose has its own column. */
export function connectionStorageProvider(vendor: string, purpose: ConnectionPurpose): string {
  return connectionProviderNames(vendor, purpose)[0];
}

/** Live authority is keyed on this connection id AND its holder, never its provider label. */
export async function readConnectionGrant(row: GrantedRow, callerDid: string, tx: GrantReader = db) {
  if (isHeldBy(row, callerDid) || row.status !== 'active' || row.revokedAt
    || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return undefined;
  const [grant] = await tx.select().from(orgConnectionMemberGrants).where(and(
    eq(orgConnectionMemberGrants.orgDid, row.ownerDid),
    eq(orgConnectionMemberGrants.memberDid, callerDid),
    eq(orgConnectionMemberGrants.connectionId, row.id),
    isNull(orgConnectionMemberGrants.revokedAt),
  )).limit(1);
  return grant;
}

export async function isGrantedTo(row: GrantedRow, callerDid: string, tx: GrantReader = db): Promise<boolean> {
  return !!await readConnectionGrant(row, callerDid, tx);
}
