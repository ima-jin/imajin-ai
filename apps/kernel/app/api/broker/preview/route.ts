import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { broker } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, consentGrants } from '@/src/db';

const log = createLogger('kernel');

/**
 * GET /api/broker/preview — "what would this requester see right now?" (#1220).
 *
 * A subject-initiated preview: the authenticated user (subject) simulates what
 * a specific requester DID would receive if they called broker() today.
 *
 * The route enforces that the requester has at least one active grant from the
 * subject before running the preview, preventing impersonation of arbitrary DIDs.
 *
 * Query params:
 *   requesterDid  string  required  — DID to simulate as the requester
 *   purpose       string  required  — purpose to preview
 *
 * Returns BrokerRelease (with preview:true) or BrokerRejection.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const subject = resolveActingDid(auth.identity);

  const url = new URL(request.url);
  const requesterDid = url.searchParams.get('requesterDid')?.trim() ?? '';
  const purpose = url.searchParams.get('purpose')?.trim() ?? '';

  if (!requesterDid) {
    return NextResponse.json({ error: 'requesterDid is required' }, { status: 400 });
  }
  if (!purpose) {
    return NextResponse.json({ error: 'purpose is required' }, { status: 400 });
  }

  // Verify the subject has at least one active grant for this requester.
  // This prevents the subject from previewing arbitrary DIDs they have no
  // relationship with (not a security boundary — it's purely UX protection).
  const [activeGrant] = await db
    .select({ id: consentGrants.id, allowedFields: consentGrants.allowedFields })
    .from(consentGrants)
    .where(
      and(
        eq(consentGrants.subject, subject),
        eq(consentGrants.grantedTo, requesterDid),
        eq(consentGrants.purpose, purpose),
        eq(consentGrants.status, 'active'),
      ),
    )
    .limit(1);

  if (!activeGrant) {
    // No active grant found — return a synthetic rejection explaining why.
    return NextResponse.json({
      status: 'rejected',
      reason: 'no_consent',
      fields: [],
      details: `No active grant found for requester=${requesterDid}, purpose=${purpose}`,
      preview: true,
    });
  }

  log.info({ subject, requesterDid, purpose }, 'Broker preview request');

  const result = await broker('profile.field.request', {
    type: 'profile.field.request',
    requester: requesterDid,
    subject,
    purpose,
    fields: activeGrant.allowedFields,
    scope: 'default',
    preview: true,
  });

  return NextResponse.json({ ...result, preview: true });
}
