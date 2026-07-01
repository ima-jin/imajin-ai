import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, consentGrants } from '@/src/db';

const log = createLogger('kernel');

interface RevokeAllBody {
  grantedTo?: string;
  purpose?: string;
}

/**
 * POST /api/broker/consent/revoke-all — bulk-revoke the acting subject's active
 * grants, filtered by recipient (`grantedTo`) and/or data type (`purpose`)
 * (#1053). At least one filter is required so a caller can never revoke every
 * grant by accident. Emits `broker.consent.revoked` per revoked row, matching
 * the single-revoke endpoint.
 */
export async function revokeAll(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const actingDid = resolveActingDid(auth.identity);

  let body: RevokeAllBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const grantedTo = typeof body.grantedTo === 'string' && body.grantedTo.trim().length > 0 ? body.grantedTo.trim() : null;
  const purpose = typeof body.purpose === 'string' && body.purpose.trim().length > 0 ? body.purpose.trim() : null;

  if (!grantedTo && !purpose) {
    return NextResponse.json({ error: 'grantedTo or purpose is required' }, { status: 400 });
  }

  const conditions = [eq(consentGrants.subject, actingDid), eq(consentGrants.status, 'active')];
  if (grantedTo) conditions.push(eq(consentGrants.grantedTo, grantedTo));
  if (purpose) conditions.push(eq(consentGrants.purpose, purpose));

  const revoked = await db
    .update(consentGrants)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(and(...conditions))
    .returning();

  for (const grant of revoked) {
    // Fire-and-forget downstream notification (mirrors DELETE /consent/:id).
    publish('broker.consent.revoked', {
      issuer: actingDid,
      subject: grant.subject,
      scope: 'broker',
      payload: {
        consentId: grant.id,
        subject: grant.subject,
        grantedTo: grant.grantedTo,
        purpose: grant.purpose,
        context_id: grant.id,
        context_type: 'consent',
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Bus publish error for broker.consent.revoked');
    });
  }

  return NextResponse.json({ ok: true, revokedCount: revoked.length, grants: revoked });
}
