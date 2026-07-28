import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { vaultService } from '@/src/lib/vault';
import { db, vaultDelegationGrants } from '@/src/db';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const entries = await vaultService.list();
    const identity = getNodeSigningIdentity();

    // Fetch all active grants for this node in one query; build a field → grant map.
    const activeGrants = await db
      .select({
        field: vaultDelegationGrants.field,
        grantedTo: vaultDelegationGrants.grantedTo,
        expiresAt: vaultDelegationGrants.expiresAt,
      })
      .from(vaultDelegationGrants)
      .where(
        and(
          eq(vaultDelegationGrants.grantedTo, identity.senderDid),
          eq(vaultDelegationGrants.status, 'active'),
        ),
      );

    const grantByField = new Map(activeGrants.map((g) => [g.field, g]));

    const results = entries.map((entry) => {
      const custodyScheme = entry.custodyScheme ?? 'node-sealed';
      const grant = custodyScheme === 'delegation-grant' ? grantByField.get(entry.field) : undefined;

      return {
        field: entry.field,
        hint: entry.encrypted.slice(0, 4),
        cid: entry.cid,
        senderDid: entry.senderDid,
        timestamp: entry.timestamp,
        status: entry.deleted === true ? 'deleted' : 'active',
        custodyScheme,
        ...(custodyScheme === 'delegation-grant' ? {
          grantedTo: grant?.grantedTo ?? null,
          expiresAt: grant?.expiresAt?.toISOString() ?? null,
          grantStatus: grant ? 'active' : 'none',
        } : {}),
      };
    });

    return NextResponse.json(results);
  } catch (error) {
    log.error({ err: String(error) }, 'Vault list error');
    return toVaultErrorResponse(error, 'Failed to list vault entries', 500);
  }
}
