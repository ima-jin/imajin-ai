import { NextRequest, NextResponse } from 'next/server';
import { db, identities, credentials } from '@/src/db';
import { eq, and } from 'drizzle-orm';

/**
 * GET /api/identity/:did/contact
 *
 * Internal endpoint — resolve a DID to its contact email.
 * Used by the notify service to resolve DID → email for broadcast sends.
 *
 * Auth: x-webhook-secret header (same secret as NOTIFY_WEBHOOK_SECRET on notify service).
 *
 * Lookup order:
 *   1. TODO(#546): auth.identities.contact_email once that column is backfilled
 *   2. auth.credentials where type='email' (login email)
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
    // Verify identity exists
    const [identity] = await db
      .select({ id: identities.id })
      .from(identities)
      .where(eq(identities.id, decodedDid))
      .limit(1);

    if (!identity) {
      return NextResponse.json({ error: 'Identity not found' }, { status: 404 });
    }

    // TODO(#546): Once contact_email is backfilled onto identities, prefer it here:
    // const contactEmail = identity.contactEmail ?? credential.value
    //
    // For now, fall back to the credentials table (login email)
    const [emailCredential] = await db
      .select({ value: credentials.value })
      .from(credentials)
      .where(and(eq(credentials.did, decodedDid), eq(credentials.type, 'email')))
      .limit(1);

    if (!emailCredential?.value) {
      return NextResponse.json({ error: 'No email found for DID' }, { status: 404 });
    }

    return NextResponse.json({ did: decodedDid, email: emailCredential.value });
  } catch (error) {
    console.error('Contact resolve error:', error);
    return NextResponse.json({ error: 'Failed to resolve contact' }, { status: 500 });
  }
}
