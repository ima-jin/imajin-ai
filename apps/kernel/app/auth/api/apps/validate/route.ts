/**
 * POST /auth/api/apps/validate
 *
 * Internal service-to-service endpoint used by requireAppAuth middleware.
 * Validates an app authorization attestation and returns AppAuthContext.
 *
 * Auth: Bearer ATTESTATION_INTERNAL_API_KEY
 * Body: { appDid, attestationId, scope? }
 * Returns: { appDid, userDid, scopes, attestationId }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, attestations } from '@/src/db';
import { eq, and } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  const apiKey = request.headers.get('authorization')?.replace('Bearer ', '');
  const expectedKey = process.env.ATTESTATION_INTERNAL_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { appDid, attestationId, scope } = body as {
    appDid?: string;
    attestationId?: string;
    scope?: string;
  };

  if (!appDid || typeof appDid !== 'string') {
    return NextResponse.json({ error: 'appDid required' }, { status: 400 });
  }
  if (!attestationId || typeof attestationId !== 'string') {
    return NextResponse.json({ error: 'attestationId required' }, { status: 400 });
  }

  const [att] = await db
    .select()
    .from(attestations)
    .where(
      and(
        eq(attestations.id, attestationId),
        eq(attestations.subjectDid, appDid),
        eq(attestations.type, 'app.authorized'),
      )
    );

  if (!att) {
    return NextResponse.json({ error: 'Authorization not found' }, { status: 404 });
  }
  if (att.revokedAt) {
    return NextResponse.json({ error: 'Authorization has been revoked' }, { status: 403 });
  }

  const payload = att.payload as { scopes?: string[] } | null;
  const approvedScopes = payload?.scopes ?? [];

  if (scope && !approvedScopes.includes(scope)) {
    return NextResponse.json(
      { error: `Scope '${scope}' was not granted` },
      { status: 403 }
    );
  }

  return NextResponse.json({
    appDid,
    userDid: att.issuerDid,
    scopes: approvedScopes,
    attestationId,
  });
}
