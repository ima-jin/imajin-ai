import { NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { db, brokerAuditLog } from '@/src/db';
import { and, desc, eq, gte, lte, or } from 'drizzle-orm';

const MAX_LIMIT = 100;

/**
 * GET /api/broker/audit — query the broker audit trail (#1050).
 *
 * Auth:
 *   - A subject can query records where they are the subject or the requester.
 *   - Admin / node-operator scope can query all records (no DID restriction).
 *
 * Filters: ?subject= ?requester= ?purpose= ?status= ?from=ISO ?to=ISO ?limit= ?offset=
 */
export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const actingDid = resolveActingDid(auth.identity);
  const isAdmin = auth.identity.scope === 'admin' || auth.identity.scope === 'node-operator';

  const url = new URL(request.url);
  const subjectFilter = url.searchParams.get('subject');
  const requesterFilter = url.searchParams.get('requester');
  const purposeFilter = url.searchParams.get('purpose');
  const statusFilter = url.searchParams.get('status');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50', 10), MAX_LIMIT);
  const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);

  const conditions = [];

  // Non-admin callers can only see records they are a party to.
  if (!isAdmin) {
    const selfFilter = or(
      eq(brokerAuditLog.subject, actingDid),
      eq(brokerAuditLog.requester, actingDid),
    );
    if (selfFilter) conditions.push(selfFilter);
  }

  if (subjectFilter) conditions.push(eq(brokerAuditLog.subject, subjectFilter));
  if (requesterFilter) conditions.push(eq(brokerAuditLog.requester, requesterFilter));
  if (purposeFilter) conditions.push(eq(brokerAuditLog.purpose, purposeFilter));
  if (statusFilter) conditions.push(eq(brokerAuditLog.status, statusFilter));
  if (from) conditions.push(gte(brokerAuditLog.createdAt, new Date(from)));
  if (to) conditions.push(lte(brokerAuditLog.createdAt, new Date(to)));

  const entries = await db
    .select()
    .from(brokerAuditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(brokerAuditLog.createdAt))
    .limit(limit)
    .offset(offset);

  return NextResponse.json({ entries, limit, offset });
}
