import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { withLogger, createLogger } from '@imajin/logger';
import { db, consentGrants } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';

const log = createLogger('kernel');

interface CreateConsentBody {
  subject?: string;
  grantedTo?: string;
  purpose?: string;
  allowedFields?: string[];
  mode?: 'attestation' | 'raw';
  expiresAt?: string;
}

// GET /api/broker/consent — list the caller's own grants.
// Filters: ?purpose= ?grantedTo= ?status=
export const GET = withLogger('kernel', async (request: NextRequest) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const subject = resolveActingDid(authResult.identity);

  const url = new URL(request.url);
  const purpose = url.searchParams.get('purpose');
  const grantedTo = url.searchParams.get('grantedTo');
  const status = url.searchParams.get('status');

  // Subjects can only ever list their own grants.
  const conditions = [eq(consentGrants.subject, subject)];
  if (purpose) conditions.push(eq(consentGrants.purpose, purpose));
  if (grantedTo) conditions.push(eq(consentGrants.grantedTo, grantedTo));
  if (status) conditions.push(eq(consentGrants.status, status));

  const grants = await db
    .select()
    .from(consentGrants)
    .where(and(...conditions))
    .orderBy(desc(consentGrants.createdAt));

  return NextResponse.json({ grants });
});

// POST /api/broker/consent — create a grant from the acting DID.
export const POST = withLogger('kernel', async (request: NextRequest) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const actingDid = resolveActingDid(authResult.identity);

  let body: CreateConsentBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { subject, grantedTo, purpose, allowedFields, mode, expiresAt } = body;

  // Users grant from themselves only.
  if (typeof subject !== 'string' || subject !== actingDid) {
    return NextResponse.json(
      { error: 'subject must equal the acting DID' },
      { status: 403 }
    );
  }
  if (typeof grantedTo !== 'string' || grantedTo.trim().length === 0) {
    return NextResponse.json({ error: 'grantedTo is required' }, { status: 400 });
  }
  if (typeof purpose !== 'string' || purpose.trim().length === 0) {
    return NextResponse.json({ error: 'purpose is required' }, { status: 400 });
  }
  if (!Array.isArray(allowedFields) || allowedFields.length === 0 ||
      !allowedFields.every((f) => typeof f === 'string')) {
    return NextResponse.json(
      { error: 'allowedFields must be a non-empty string array' },
      { status: 400 }
    );
  }
  if (mode !== undefined && mode !== 'attestation' && mode !== 'raw') {
    return NextResponse.json(
      { error: "mode must be 'attestation' or 'raw'" },
      { status: 400 }
    );
  }

  let expiresAtDate: Date | null = null;
  if (expiresAt !== undefined) {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: 'expiresAt must be a valid ISO 8601 date' },
        { status: 400 }
      );
    }
    expiresAtDate = parsed;
  }

  const [grant] = await db
    .insert(consentGrants)
    .values({
      id: generateId('consent'),
      subject,
      grantedTo: grantedTo.trim(),
      purpose: purpose.trim(),
      allowedFields,
      mode: mode ?? 'attestation',
      status: 'active',
      consentRef: generateId('cg'),
      expiresAt: expiresAtDate,
    })
    .returning();

  // Fire-and-forget downstream notification.
  publish('broker.consent.created', {
    issuer: actingDid,
    subject,
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
    log.error({ err: String(err) }, 'Bus publish error for broker.consent.created');
  });

  return NextResponse.json(grant, { status: 201 });
});
