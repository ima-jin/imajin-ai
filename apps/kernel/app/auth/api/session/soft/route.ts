import { NextRequest, NextResponse } from 'next/server';
import { publish } from '@imajin/bus';
import { db, identities, credentials } from '@/src/db';
import { consumePendingInvites } from '@/src/lib/auth/consume-invite';
import { rateLimit, getClientIP, corsHeaders } from '@imajin/config';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/session/soft
 * Server-side soft DID resolver: create or retrieve an unverified soft identity
 * by email address. Returns the DID only — does NOT issue a session cookie.
 *
 * Intended for server-to-server use (checkout, payment webhooks). Browser
 * clients must go through POST /api/onboard → GET /api/onboard/verify to
 * obtain a verified session.
 *
 * Body: {
 *   email: string,
 *   name?: string
 * }
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  // IP-level guard: 10 req/min
  const ip = getClientIP(request);
  const ipRl = rateLimit(ip, 10, 60_000);
  if (ipRl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: ipRl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(ipRl.retryAfter) } }
    );
  }

  try {
    const body = await request.json();
    const { email, name } = body;

    // Validate email
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json(
        { error: 'Valid email required' },
        { status: 400, headers: cors }
      );
    }

    // Normalize email to lowercase
    const normalizedEmail = email.toLowerCase().trim();

    // Email-level guard: 3 lookups/creations per email per hour
    const emailRl = rateLimit(`soft-email:${normalizedEmail}`, 3, 3_600_000);
    if (emailRl.limited) {
      return NextResponse.json(
      { error: 'Too many requests', retryAfter: emailRl.retryAfter },
        { status: 429, headers: { ...cors, 'Retry-After': String(emailRl.retryAfter) } }
      );
    }

    // Check if a credential already exists for this email (prevents duplicate DIDs)
    const [existingCred] = await db
      .select({ did: credentials.did })
      .from(credentials)
      .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalizedEmail)))
      .limit(1);

    let identity: typeof identities.$inferSelect[];

    if (existingCred?.did) {
      identity = await db
        .select()
        .from(identities)
        .where(eq(identities.id, existingCred.did))
        .limit(1);

      // Update name if provided and/or backfill contact_email if missing
      if (identity.length > 0) {
        const wantNameUpdate = !!name;
        const missingEmail = !identity[0].contactEmail;
        if (wantNameUpdate || missingEmail) {
          const [updated] = await db
            .update(identities)
            .set({
              ...(wantNameUpdate ? { name: name!.trim() } : {}),
              ...(missingEmail ? { contactEmail: normalizedEmail } : {}),
              updatedAt: new Date(),
            })
            .where(eq(identities.id, existingCred.did))
            .returning();
          identity = [updated];
        }
      }
    } else {
      // Mint a new stable DID
      const did = `did:imajin:${nanoid(44)}`;
      const placeholderKey = `soft_${nanoid(32)}`;

      const [newIdentity] = await db
        .insert(identities)
        .values({
          id: did,
          scope: 'actor',
          subtype: 'human',
          publicKey: placeholderKey,
          handle: null,
          name: name?.trim() || null,
          contactEmail: normalizedEmail,
          metadata: { email: normalizedEmail, tier: 'soft' },
        })
        .returning();

      // Insert email credential — verifiedAt is null until the user completes
      // the email challenge via POST /api/onboard → GET /api/onboard/verify.
      await db.insert(credentials).values({
        id: `cred_${nanoid(16)}`,
        did,
        type: 'email',
        value: normalizedEmail,
        verifiedAt: null,
      });

      identity = [newIdentity];

      // Emit identity.created → triggers 10 MJN welcome emission
      publish('identity.created', {
        issuer: did,
        subject: did,
        scope: 'auth',
        payload: {
          did,
          scope: 'actor',
          subtype: 'human',
          tier: 'soft',
          context_id: did,
          context_type: 'identity',
        },
      }).catch((err) => log.error({ err: String(err) }, '[session/soft] identity.created publish error (non-fatal)'));

      // Auto-consume any pending invites sent to this email — fire and forget
      consumePendingInvites({
        did,
        email: normalizedEmail,
      }).catch(() => {});
    }

    // Return identity metadata only — no session token, no cookie.
    return NextResponse.json({
      did: identity[0].id,
      handle: identity[0].handle,
      scope: identity[0].scope,
      subtype: identity[0].subtype,
      name: identity[0].name,
      tier: 'soft',
    }, { headers: cors });

  } catch (error) {
    log.error({ err: String(error) }, 'Soft session error');
    return NextResponse.json(
      { error: 'Failed to create soft session' },
      { status: 500, headers: cors }
    );
  }
}
