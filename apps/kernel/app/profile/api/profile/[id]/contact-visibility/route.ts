/**
 * PUT /profile/api/profile/:id/contact-visibility
 *
 * Owner-only endpoint to upsert or revoke the contact.disclosure consent grant
 * for the caller's profile. Allows the owner to widen, tighten, or revoke who
 * can see their vault-stored email and phone via the broker pipeline.
 *
 * Body:
 *   action        'grant' | 'revoke'        required
 *   grantedToClass 'connections' | 'one_degree' | 'strangers'   used when action='grant'
 *   grantedTo     string                    optional — specific DID; overrides grantedToClass
 *   fields        string[]                  optional — subset of ['email','phone']; default both
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, consentGrants } from '@/src/db';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { eq, and } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';

const ALLOWED_FIELDS = new Set(['email', 'phone']);
const ALLOWED_CLASSES = new Set(['connections', 'one_degree', 'strangers']);

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const effectiveDid = resolveActingDid(authResult.identity);

  // Resolve the profile and confirm ownership
  const profile = await db.query.profiles.findFirst({
    where: (profiles, { eq, or }) => or(eq(profiles.did, id), eq(profiles.handle, id)),
  });

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: cors });
  }
  if (profile.did !== authResult.identity.id && profile.did !== effectiveDid) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403, headers: cors });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { action, grantedToClass, grantedTo, fields } = body;

  if (action !== 'grant' && action !== 'revoke') {
    return NextResponse.json({ error: "action must be 'grant' or 'revoke'" }, { status: 400, headers: cors });
  }

  // Validate requested fields
  const allowedFields: string[] = Array.isArray(fields)
    ? (fields as unknown[]).filter((f): f is string => typeof f === 'string' && ALLOWED_FIELDS.has(f))
    : ['email', 'phone'];

  if (allowedFields.length === 0) {
    return NextResponse.json({ error: 'No valid fields specified' }, { status: 400, headers: cors });
  }

  if (action === 'revoke') {
    await db
      .update(consentGrants)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(
        and(
          eq(consentGrants.subject, profile.did),
          eq(consentGrants.purpose, 'contact.disclosure'),
          eq(consentGrants.status, 'active')
        )
      );
    return NextResponse.json({ status: 'revoked' }, { headers: cors });
  }

  // action === 'grant'
  const specificDid = typeof grantedTo === 'string' ? grantedTo : null;
  let targetClass: string | null;
  if (specificDid) {
    targetClass = null;
  } else if (typeof grantedToClass === 'string' && ALLOWED_CLASSES.has(grantedToClass)) {
    targetClass = grantedToClass;
  } else {
    targetClass = 'connections'; // default to connections
  }

  // Revoke any existing active grant before creating the new one (replace semantics)
  await db
    .update(consentGrants)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(
      and(
        eq(consentGrants.subject, profile.did),
        eq(consentGrants.purpose, 'contact.disclosure'),
        eq(consentGrants.status, 'active')
      )
    );

  const grant = await db
    .insert(consentGrants)
    .values({
      id: generateId('cg'),
      subject: profile.did,
      grantedTo: specificDid,
      grantedToClass: targetClass,
      purpose: 'contact.disclosure',
      allowedFields,
      mode: 'raw',
      status: 'active',
      consentRef: generateId('cref'),
    })
    .returning();

  return NextResponse.json({ status: 'granted', grant: grant[0] }, { headers: cors });
}
