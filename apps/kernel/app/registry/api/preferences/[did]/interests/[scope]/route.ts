import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { nanoid } from 'nanoid';
import { db, didInterests, didPreferences } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { authorizePreferenceDid } from '@/src/lib/notify/registry-auth';

const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * PUT /api/preferences/[did]/interests/[scope]
 * Toggle per-scope marketing + channel booleans.
 * Requires the session DID to match :did. The vault internal Bearer lane may
 * only disable marketing/email (the signed email unsubscribe return path).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ did: string; scope: string }> }
) {
  const cors = corsHeaders(request);

  const { did, scope } = await params;
  const auth = await authorizePreferenceDid(request, did, cors);
  if (auth.error) return auth.error;
  const isInternal = auth.internal;

  let body: { marketing?: boolean; email?: boolean; inapp?: boolean; chat?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }
  // The internal unsubscribe lane may only turn email/marketing OFF.
  if (isInternal && (
    body.marketing !== false || body.email !== false ||
    Object.keys(body).some((key) => key !== 'marketing' && key !== 'email')
  )) {
    return NextResponse.json({ error: 'Internal writes may only unsubscribe' }, { status: 403, headers: cors });
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
          inapp: isInternal ? false : body.inapp ?? true,
          chat: isInternal ? false : body.chat ?? true,
        })
        .returning();
    }

    return NextResponse.json({ interest: result }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, '[preferences/did/interests/scope] put error');
    return NextResponse.json({ error: 'Failed to update interest preference' }, { status: 500, headers: cors });
  }
}

/**
 * POST /api/preferences/[did]/interests/[scope]
 * Create a per-scope interest row lazily (called by notify interest signal).
 * Auth: vault internal Bearer OR session DID match.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string; scope: string }> }
) {
  const cors = corsHeaders(request);

  const { did, scope } = await params;

  const auth = await authorizePreferenceDid(request, did, cors);
  if (auth.error) return auth.error;

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
    log.error({ err: String(error) }, '[preferences/did/interests/scope] post error');
    return NextResponse.json({ error: 'Failed to create interest preference' }, { status: 500, headers: cors });
  }
}
