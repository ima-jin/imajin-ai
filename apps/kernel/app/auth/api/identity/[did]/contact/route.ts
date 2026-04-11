import { NextRequest, NextResponse } from 'next/server';
import { db, identities, credentials } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * GET /api/identity/:did/contact
 *
 * Internal endpoint — resolve a DID to its contact email.
 * Used by the notify service to resolve DID → email for broadcast sends.
 *
 * Auth: x-webhook-secret header (must match NOTIFY_WEBHOOK_SECRET).
 *
 * Lookup order:
 *   1. auth.identities.contact_email (backfilled from Stripe / ticket metadata)
 *   2. auth.credentials where type='email' (login email fallback)
 *
 * Returns: { did, email }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const secret = request.headers.get('x-webhook-secret');
  if (!secret || secret !== process.env.NOTIFY_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { did } = await params;
  const decodedDid = decodeURIComponent(did);

  try {
    const [identity] = await db
      .select({ id: identities.id, contactEmail: identities.contactEmail })
      .from(identities)
      .where(eq(identities.id, decodedDid))
      .limit(1);

    if (!identity) {
      return NextResponse.json({ error: 'Identity not found' }, { status: 404 });
    }

    // Prefer contact_email, fall back to credentials
    let email = identity.contactEmail;

    if (!email) {
      const [emailCredential] = await db
        .select({ value: credentials.value })
        .from(credentials)
        .where(and(eq(credentials.did, decodedDid), eq(credentials.type, 'email')))
        .limit(1);

      email = emailCredential?.value ?? null;
    }

    if (!email) {
      return NextResponse.json({ error: 'No email found for DID' }, { status: 404 });
    }

    return NextResponse.json({ did: decodedDid, email });
  } catch (error) {
    log.error({ err: String(error) }, 'Contact resolve error');
    return NextResponse.json({ error: 'Failed to resolve contact' }, { status: 500 });
  }
}
