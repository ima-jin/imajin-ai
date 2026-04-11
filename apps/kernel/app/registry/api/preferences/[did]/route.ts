import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { requireAuth } from '@imajin/auth';
import { db, didPreferences, didInterests, interests } from '@/src/db';
import { eq, asc } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/preferences/[did]
 * Returns global prefs + all interest scopes with channel toggles for this DID.
 * Requires the authenticated session DID to match the :did param.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const { did } = await params;

  const effectiveDid = authResult.identity.actingAs || authResult.identity.id;

  if (effectiveDid !== did) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: cors });
  }

  try {
    // Get or return default global preferences
    const [globalPref] = await db
      .select()
      .from(didPreferences)
      .where(eq(didPreferences.did, did))
      .limit(1);

    // Get all interest scopes for this DID
    const interestRows = await db
      .select()
      .from(didInterests)
      .where(eq(didInterests.did, did))
      .orderBy(asc(didInterests.scope));

    return NextResponse.json({
      preferences: globalPref ?? {
        did,
        globalMarketing: true,
        autoSubscribe: true,
        createdAt: null,
        updatedAt: null,
      },
      interests: interestRows,
    }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, '[preferences/did] get error');
    return NextResponse.json({ error: 'Failed to get preferences' }, { status: 500, headers: cors });
  }
}

/**
 * PUT /api/preferences/[did]
 * Update global_marketing / auto_subscribe for this DID.
 * Requires the authenticated session DID to match the :did param.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const { did } = await params;

  const effectiveDid = authResult.identity.actingAs || authResult.identity.id;

  if (effectiveDid !== did) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: cors });
  }

  let body: { globalMarketing?: boolean; autoSubscribe?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  try {
    const [existing] = await db
      .select()
      .from(didPreferences)
      .where(eq(didPreferences.did, did))
      .limit(1);

    let result;
    if (existing) {
      [result] = await db
        .update(didPreferences)
        .set({
          ...(body.globalMarketing !== undefined && { globalMarketing: body.globalMarketing }),
          ...(body.autoSubscribe !== undefined && { autoSubscribe: body.autoSubscribe }),
          updatedAt: new Date(),
        })
        .where(eq(didPreferences.did, did))
        .returning();
    } else {
      [result] = await db
        .insert(didPreferences)
        .values({
          did,
          globalMarketing: body.globalMarketing ?? true,
          autoSubscribe: body.autoSubscribe ?? true,
        })
        .returning();
    }

    return NextResponse.json({ preferences: result }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, '[preferences/did] put error');
    return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500, headers: cors });
  }
}
