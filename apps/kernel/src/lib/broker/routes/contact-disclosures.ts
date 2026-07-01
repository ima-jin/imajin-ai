import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { db, consentGrants, brokerAuditLog } from '@/src/db';

/**
 * GET /api/broker/contacts/[did]/disclosures — disclosure timeline for one
 * recipient DID (#1053): the subject's grants to that recipient (active and
 * revoked) plus the audit trail of releases / denials against them. The UI
 * merges the two into a single chronological timeline. Subjects only ever see
 * their own records (fail-closed).
 */
export async function getContactDisclosures(request: Request, did: string): Promise<Response> {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const subject = resolveActingDid(auth.identity);

  const recipient = did.trim();
  if (!recipient) return NextResponse.json({ error: 'did is required' }, { status: 400 });

  const grants = await db
    .select()
    .from(consentGrants)
    .where(and(eq(consentGrants.subject, subject), eq(consentGrants.grantedTo, recipient)))
    .orderBy(desc(consentGrants.createdAt));

  const audit = await db
    .select()
    .from(brokerAuditLog)
    .where(and(eq(brokerAuditLog.subject, subject), eq(brokerAuditLog.requester, recipient)))
    .orderBy(desc(brokerAuditLog.createdAt));

  return NextResponse.json({ did: recipient, grants, audit });
}
