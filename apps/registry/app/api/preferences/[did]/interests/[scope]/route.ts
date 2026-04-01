import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { requireAuth } from '@imajin/auth';
import { nanoid } from 'nanoid';
import { db, didInterests, didPreferences } from '@/src/db';
import { eq, and } from 'drizzle-orm';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * PUT /api/preferences/[did]/interests/[scope]
 * Toggle per-scope marketing + channel booleans.
 * Requires the authenticated session DID to match the :did param.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ did: string; scope: string }> }
) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const { did, scope } = await params;

  if (authResult.identity.id !== did) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: cors });
  }

  let body: { marketing?: boolean; email?: boolean; inapp?: boolean; chat?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  try {
    const [existing] = await db
      .select()
      .from(didInterests)
      .where(and(eq(didInterests.did, did), eq(didInterests.scope, scope)))
      .limit(1);

    let result;
    if (existing) {
      [result] = await db
        .update(didInterests)
        .set({
          ...(body.marketing !== undefined && { marketing: body.marketing }),
          ...(body.email !== undefined && { email: body.email }),
          ...(body.inapp !== undefined && { inapp: body.inapp }),
          ...(body.chat !== undefined && { chat: body.chat }),
          updatedAt: new Date(),
        })
        .where(and(eq(didInterests.did, did), eq(didInterests.scope, scope)))
        .returning();
    } else {
      const id = `din_${nanoid(16)}`;
      [result] = await db
        .insert(didInterests)
        .values({
          id,
          did,
          scope,
          marketing: body.marketing ?? true,
          email: body.email ?? true,
          inapp: body.inapp ?? true,
          chat: body.chat ?? true,
        })
        .returning();
    }

    return NextResponse.json({ interest: result }, { headers: cors });
  } catch (error) {
    console.error('[preferences/did/interests/scope] put error:', error);
    return NextResponse.json({ error: 'Failed to update interest preference' }, { status: 500, headers: cors });
  }
}

/**
 * POST /api/preferences/[did]/interests/[scope]
 * Create a per-scope interest row lazily (called by notify interest signal).
 * Auth: x-webhook-secret (internal service call) OR session DID match.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string; scope: string }> }
) {
  const cors = corsHeaders(request);

  const { did, scope } = await params;

  // Allow internal service calls via webhook secret
  const webhookSecret = request.headers.get('x-webhook-secret');
  const isInternal = webhookSecret && webhookSecret === process.env.NOTIFY_WEBHOOK_SECRET;

  if (!isInternal) {
    // Fall back to session auth with DID check
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
    }
    if (authResult.identity.id !== did) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: cors });
    }
  }

  let body: { marketing?: boolean; email?: boolean; inapp?: boolean; chat?: boolean; createdByAttestation?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    // Check if row already exists
    const [existing] = await db
      .select()
      .from(didInterests)
      .where(and(eq(didInterests.did, did), eq(didInterests.scope, scope)))
      .limit(1);

    if (existing) {
      return NextResponse.json({ interest: existing, created: false }, { headers: cors });
    }

    // Check auto_subscribe preference to determine default channel state
    const [globalPref] = await db
      .select()
      .from(didPreferences)
      .where(eq(didPreferences.did, did))
      .limit(1);

    const autoSubscribe = globalPref?.autoSubscribe ?? true;
    const id = `din_${nanoid(16)}`;

    const [result] = await db
      .insert(didInterests)
      .values({
        id,
        did,
        scope,
        marketing: autoSubscribe,
        email: autoSubscribe,
        inapp: autoSubscribe,
        chat: autoSubscribe,
        createdByAttestation: body.createdByAttestation ?? null,
      })
      .returning();

    return NextResponse.json({ interest: result, created: true }, { status: 201, headers: cors });
  } catch (error) {
    console.error('[preferences/did/interests/scope] post error:', error);
    return NextResponse.json({ error: 'Failed to create interest preference' }, { status: 500, headers: cors });
  }
}
