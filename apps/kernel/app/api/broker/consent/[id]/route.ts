import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, consentGrants } from '@/src/db';

const log = createLogger('kernel');

// DELETE /api/broker/consent/:id — revoke a grant (owner only).
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const actingDid = resolveActingDid(authResult.identity);

  const [existing] = await db
    .select({ id: consentGrants.id, subject: consentGrants.subject })
    .from(consentGrants)
    .where(eq(consentGrants.id, params.id));

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (existing.subject !== actingDid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const [revoked] = await db
    .update(consentGrants)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(eq(consentGrants.id, params.id))
    .returning();

  // Fire-and-forget downstream notification.
  publish('broker.consent.revoked', {
    issuer: actingDid,
    subject: revoked.subject,
    scope: 'broker',
    payload: {
      consentId: revoked.id,
      subject: revoked.subject,
      grantedTo: revoked.grantedTo,
      purpose: revoked.purpose,
      context_id: revoked.id,
      context_type: 'consent',
    },
  }).catch((err: unknown) => {
    log.error({ err: String(err) }, 'Bus publish error for broker.consent.revoked');
  });

  return NextResponse.json({ ok: true, grant: revoked });
}
