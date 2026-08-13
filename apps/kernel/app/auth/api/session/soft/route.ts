import { NextRequest, NextResponse } from 'next/server';
import { publish } from '@imajin/bus';
import { db, identities, credentials } from '@/src/db';
import { consumePendingInvites } from '@/src/lib/auth/consume-invite';
import { mintOrAccrueClaimableStub } from '@/src/lib/auth/claimable-stub';
import { rateLimit, getClientIP, corsHeaders } from '@imajin/config';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * Backfill `name`/`contactEmail` on an identity when they're missing.
 * No-op (returns `identity` unchanged) when neither backfill applies.
 * Shared by both branches of `POST` to keep its own cognitive complexity down.
 */
async function backfillIdentityContact(
  did: string,
  identity: typeof identities.$inferSelect,
  name: string | undefined,
  normalizedEmail: string,
): Promise<typeof identities.$inferSelect> {
  const wantNameUpdate = !!name;
  const missingEmail = !identity.contactEmail;
  if (!wantNameUpdate && !missingEmail) return identity;

  const [updated] = await db
    .update(identities)
    .set({
      ...(wantNameUpdate ? { name: name!.trim() } : {}),
      ...(missingEmail ? { contactEmail: normalizedEmail } : {}),
      updatedAt: new Date(),
    })
    .where(eq(identities.id, did))
    .returning();
  return updated;
}

/**
 * Mint-or-accrue via the claimable-stub primitive (#1834 Phase 3): dedupes
 * against any stub already minted for this email by another introduction
 * path (connections invite, onboard, business-place, ...) via the HMAC
 * index, instead of unconditionally minting a fresh DID scoped only to this
 * route's own credentials-table check. "One DID per email" (#1834 design
 * pt. 1) now holds across every mint site.
 *
 * No plaintext-searchable `credentials` row is inserted for an unverified
 * stub any more (#1834 design pt. 4 — the stub holds no plaintext-searchable
 * PII); the stub stays findable only through the encrypted/HMAC-keyed
 * `claim_stub_index` until it's actually claimed via
 * POST /api/onboard → GET /api/onboard/verify.
 */
async function resolveViaClaimableStubPrimitive(
  normalizedEmail: string,
  name: string | undefined,
): Promise<typeof identities.$inferSelect> {
  const { did, isNewStub } = await mintOrAccrueClaimableStub(normalizedEmail);

  const [freshIdentity] = await db
    .select()
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);

  if (!freshIdentity) {
    throw new Error(`[session/soft] claimable stub ${did} has no identities row`);
  }

  const identity = await backfillIdentityContact(did, freshIdentity, name, normalizedEmail);

  if (isNewStub) {
    // Emit identity.created → triggers 10 MJN welcome emission. Only on an
    // actual first mint — accruing to a stub minted elsewhere must not
    // re-trigger the welcome bonus.
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
  }

  // Auto-consume any pending invites sent to this email — fire and forget
  consumePendingInvites({ did, email: normalizedEmail }).catch(() => {});

  return identity;
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

    let identity: typeof identities.$inferSelect;

    if (existingCred?.did) {
      const [existingIdentity] = await db
        .select()
        .from(identities)
        .where(eq(identities.id, existingCred.did))
        .limit(1);

      if (!existingIdentity) {
        // Defensive: credentials.did references identities.id, so this
        // shouldn't happen — surfaces as the existing 500 catch-all below.
        throw new Error(`[session/soft] credential ${existingCred.did} has no identities row`);
      }
      identity = await backfillIdentityContact(existingCred.did, existingIdentity, name, normalizedEmail);
    } else {
      identity = await resolveViaClaimableStubPrimitive(normalizedEmail, name);
    }

    // Return identity metadata only — no session token, no cookie.
    return NextResponse.json({
      did: identity.id,
      handle: identity.handle,
      scope: identity.scope,
      subtype: identity.subtype,
      name: identity.name,
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
