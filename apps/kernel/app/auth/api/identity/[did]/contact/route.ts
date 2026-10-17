import { NextRequest, NextResponse } from 'next/server';
import { db, identities, credentials } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { requireInternalApiKey } from '@/src/lib/auth/require-internal-api-key';
import { authenticateContactApp, relatedContactDids } from '@/src/lib/profile/app-contact-auth';
import { backfillContact } from '@/src/lib/profile/backfill-contact';
import { corsHeaders, corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

export { OPTIONS };
export const dynamic = 'force-dynamic';

const log = createLogger('kernel');

/**
 * GET /api/identity/:did/contact
 *
 * Internal endpoint — resolve a DID to its contact email.
 * Used by the notify service to resolve DID → email for broadcast sends.
 *
 * Auth: vault-sourced internal Bearer key.
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
  const authError = await requireInternalApiKey(request);
  if (authError) return authError;

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
 * Backfill `auth.identities.contact_email` and `profile.profiles.contact_email`
 * (#2058, sibling of #1999/#2053). NULL-guarded: only ever sets the column
 * when it is currently unset, so repeated calls for the same buyer (every
 * checkout, every webhook retry) are safe no-ops once a value is on file.
 * `contact_email` is a billing/notification address (see the column comment
 * in src/db/schemas/auth.ts) — recording it is not a verification event, so
 * unlike POST /api/eligibility/evaluate this never emits an attestation.
 * The deliberate, user-initiated `email_verified` flow
 * (app/profile/api/contact/verify-email/) is unrelated and untouched.
 *
 * Auth: vault-only internal Bearer, or an active registered app-service token
 * with live operator-approved `profile:contact:backfill` and a kernel-recorded
 * relationship to this DID. GET remains internal-only. An app's write scope
 * never authorizes reading an existing address: contactEmail is null for apps.
 *
 * Body: { email: string }
 * Returns: { did, contactEmail, backfilled }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);

  const { did } = await params;
  const decodedDid = decodeURIComponent(did);
  let isApp = false;
  try {
    const authError = await requireInternalApiKey(request);
    if (authError) {
      const app = await authenticateContactApp(request, 'profile:contact:backfill');
      if ('error' in app) {
        return NextResponse.json({ error: app.error }, { status: app.status, headers: cors });
      }
      const related = await relatedContactDids(app.appDid, [decodedDid], 'profile:contact:backfill');
      if (!related.includes(decodedDid)) {
        return NextResponse.json({ error: 'Forbidden - no app relationship' }, { status: 403, headers: cors });
      }
      isApp = true;
    }
  } catch {
    log.error({}, 'Contact authorization unavailable');
    return NextResponse.json({ error: 'Contact authorization unavailable' }, { status: 503, headers: cors });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const email = body && typeof body === 'object' ? (body as Record<string, unknown>).email : null;
  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'email required' }, { status: 400, headers: cors });
  }

  const normalizedEmail = email.toLowerCase().trim();
  if (!normalizedEmail) {
    return NextResponse.json({ error: 'email required' }, { status: 400, headers: cors });
  }

  try {
    const result = await backfillContact(decodedDid, normalizedEmail);
    if (!result) {
      return NextResponse.json({ error: 'Identity not found' }, { status: 404, headers: cors });
    }
    return NextResponse.json({ ...result, contactEmail: isApp ? null : result.contactEmail }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), did: decodedDid }, 'Contact email backfill error');
    return NextResponse.json({ error: 'Failed to backfill contact email' }, { status: 500, headers: cors });
  }
}
