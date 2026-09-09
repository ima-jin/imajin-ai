import { NextRequest, NextResponse } from 'next/server';
import { db, identities, credentials } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { requireInternalApiKey } from '@/src/lib/auth/require-internal-api-key';

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

/**
 * POST /auth/api/identity/:did/contact
 *
 * Internal endpoint — backfill `auth.identities.contact_email` for a DID
 * (#2058, sibling of #1999/#2053). NULL-guarded: only ever sets the column
 * when it is currently unset, so repeated calls for the same buyer (every
 * checkout, every webhook retry) are safe no-ops once a value is on file.
 * `contact_email` is a billing/notification address (see the column comment
 * in src/db/schemas/auth.ts) — recording it is not a verification event, so
 * unlike POST /api/eligibility/evaluate this never emits an attestation.
 * The deliberate, user-initiated `email_verified` flow
 * (app/profile/api/contact/verify-email/) is unrelated and untouched.
 *
 * Auth: service-to-service via requireInternalApiKey (Bearer
 * ATTESTATION_INTERNAL_API_KEY, shared with /api/eligibility/evaluate and
 * the attestations routes, #2053). Both apps/events call sites resolve/
 * validate the email before calling this route themselves (an
 * `optionalAuth`-checked session for checkout, or a Stripe webhook payload
 * with no end-user session at all) — there is no session belonging to `did`
 * to forward, so this mirrors eligibility/evaluate's reasoning rather than
 * requireAuth/actingFor.
 *
 * Body: { email: string }
 * Returns: { did, contactEmail, backfilled }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const authError = requireInternalApiKey(request);
  if (authError) return authError;

  const { did } = await params;
  const decodedDid = decodeURIComponent(did);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { email } = body;
  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }

  const normalizedEmail = email.toLowerCase().trim();
  if (!normalizedEmail) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }

  try {
    const [updated] = await db
      .update(identities)
      .set({ contactEmail: normalizedEmail })
      .where(and(eq(identities.id, decodedDid), isNull(identities.contactEmail)))
      .returning({ contactEmail: identities.contactEmail });

    if (updated) {
      return NextResponse.json({ did: decodedDid, contactEmail: updated.contactEmail, backfilled: true });
    }

    // The NULL guard prevented the write — either the identity doesn't
    // exist at all, or it already has a contact_email. Distinguish the two
    // so the caller isn't left guessing.
    const [existing] = await db
      .select({ contactEmail: identities.contactEmail })
      .from(identities)
      .where(eq(identities.id, decodedDid))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: 'Identity not found' }, { status: 404 });
    }

    return NextResponse.json({ did: decodedDid, contactEmail: existing.contactEmail, backfilled: false });
  } catch (error) {
    log.error({ err: String(error), did: decodedDid }, 'Contact email backfill error');
    return NextResponse.json({ error: 'Failed to backfill contact email' }, { status: 500 });
  }
}
