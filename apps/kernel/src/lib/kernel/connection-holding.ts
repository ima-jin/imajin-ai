import { and, eq, isNull } from 'drizzle-orm';
import type { ConnectorRow } from '@/src/db';

export type ConnectionPurpose = 'inference' | 'billing';
type ProviderRow = { provider: string; purpose?: ConnectionPurpose; upstreamBinding?: string | null };
type HeldRow = Pick<ConnectorRow, 'ownerDid'>;
type GrantedRow = HeldRow & Pick<ConnectorRow, 'id' | 'status' | 'revokedAt' | 'expiresAt'>;
type GrantReader = Pick<typeof import('@/src/db').db, 'select'>;

/** Ownership never depends on identity scope, provenance, or provider spelling. */
export const isHeldBy = (row: HeldRow, did: string) => row.ownerDid === did;

/** Vendor and purpose are independent columns; names carry no authority. */
export function connectorVendor(row: ProviderRow): string {
  return row.provider;
}

export function connectorPurpose(row: ProviderRow): ConnectionPurpose {
  return row.purpose ?? 'inference';
}

/** The member-approved declaration digest, never a vendor name, identifies upstream use. */
export function isUpstreamConnection(row: ProviderRow): boolean {
  return !!row.upstreamBinding;
}

/** Live authority is keyed on this connection id AND its holder, never its provider label. */
export async function readConnectionGrant(row: GrantedRow, callerDid: string, tx?: GrantReader) {
  if (isHeldBy(row, callerDid) || row.status !== 'active' || row.revokedAt
    || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return undefined;
  const { db, orgConnectionMemberGrants } = await import('@/src/db');
  const [grant] = await (tx ?? db).select().from(orgConnectionMemberGrants).where(and(
    eq(orgConnectionMemberGrants.orgDid, row.ownerDid),
    eq(orgConnectionMemberGrants.memberDid, callerDid),
    eq(orgConnectionMemberGrants.connectionId, row.id),
    isNull(orgConnectionMemberGrants.revokedAt),
  )).limit(1);
  return grant;
}

export async function isGrantedTo(row: GrantedRow, callerDid: string, tx?: GrantReader): Promise<boolean> {
  return !!await readConnectionGrant(row, callerDid, tx);
}
