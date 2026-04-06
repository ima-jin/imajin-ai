import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { requireAuth } from '@imajin/auth';
import { nanoid } from 'nanoid';
import { db } from '@/src/db';
import { preferences } from '@/src/db';
import { eq, and } from 'drizzle-orm';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ scope: string }> }
) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  const did = identity.actingAs || identity.id;

  const { scope } = await params;

  let body: { email?: boolean; inapp?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const existing = await db
    .select()
    .from(preferences)
    .where(and(eq(preferences.did, did), eq(preferences.scope, scope)))
    .limit(1);

  if (existing.length > 0) {
    const updated = await db
      .update(preferences)
      .set({
        ...(body.email !== undefined && { email: body.email }),
        ...(body.inapp !== undefined && { inapp: body.inapp }),
      })
      .where(and(eq(preferences.did, did), eq(preferences.scope, scope)))
      .returning();
    return NextResponse.json({ preference: updated[0] }, { headers: cors });
  } else {
    const id = `prf_${nanoid(16)}`;
    const inserted = await db
      .insert(preferences)
      .values({
        id,
        did,
        scope,
        email: body.email ?? true,
        inapp: body.inapp ?? true,
      })
      .returning();
    return NextResponse.json({ preference: inserted[0] }, { headers: cors });
  }
}
