import type { NextRequest } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db, transactions, channelLinks } from '@/src/db';
import { authenticatePayApp as authenticateRegisteredApp } from '@/src/lib/pay/app-service-auth';
import { APP_AUTHORIZATION_CHANNEL } from '@/src/lib/auth/app-authorization-grant';
import { verifyAppServiceToken } from '@/src/lib/auth/jwt';

export type AppContactScope = 'profile:email:read' | 'profile:contact:backfill';

/** Same JWT, active registration and live operator approval as pay/notify. */
export async function authenticateContactApp(request: NextRequest, scope: AppContactScope) {
  const header = request.headers.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!await verifyAppServiceToken(token)) {
    return { error: 'Unauthorized - valid app-service token required', status: 401 };
  }
  return authenticateRegisteredApp(request, scope);
}

/**
 * Only kernel-recorded relationships count. Never trust a caller's purchase
 * metadata, app slug, email match or unbound/anonymous transaction.
 * An active, scoped OAuth grant is revocable independently of service approval.
 */
export async function relatedContactDids(
  appDid: string,
  dids: string[],
  scope: AppContactScope,
): Promise<string[]> {
  if (dids.length === 0) return [];
  const payments = await db
    .select({ did: transactions.fromDid })
    .from(transactions)
    .where(and(
      eq(transactions.appDid, appDid),
      eq(transactions.status, 'completed'),
      inArray(transactions.fromDid, dids),
    ));
  const paid = new Set(payments.map((row) => row.did));
  const unpaid = dids.filter((did) => !paid.has(did));
  if (unpaid.length === 0) return dids;

  const grants = await db
    .select({ did: channelLinks.did, scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(and(
      eq(channelLinks.channel, APP_AUTHORIZATION_CHANNEL),
      eq(channelLinks.appDid, appDid),
      eq(channelLinks.status, 'active'),
      inArray(channelLinks.did, unpaid),
    ));
  const granted = new Set(grants
    .filter((row) => Array.isArray(row.scopes) && row.scopes.includes(scope))
    .map((row) => row.did));
  return dids.filter((did) => paid.has(did) || granted.has(did));
}
