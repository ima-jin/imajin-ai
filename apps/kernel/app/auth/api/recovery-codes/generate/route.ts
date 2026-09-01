import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, rateLimit } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { requireAuth } from '@/src/lib/auth/middleware';
import { generateRecoveryCodes, RECOVERY_DISCLOSURE } from '@/src/lib/auth/recovery-codes';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /auth/api/recovery-codes/generate
 *
 * Generates a fresh batch of one-time recovery codes for the authenticated
 * self-custody identity. Used both at genesis (right after registration,
 * while the session from /api/register is still live) and as an explicit
 * "regenerate" call for an existing DID. Codes are shown ONCE in this
 * response — the server only ever stores a one-way hash.
 *
 * Regeneration invalidates any previously-issued, still-active codes.
 *
 * Body: { count?: number } (defaults to RECOVERY_CODE_COUNT env or 10, clamped 4-20)
 * Returns: { did, codes: string[], count, generatedAt, disclosure, warning }
 */
export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const session = await requireAuth(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
    }

    // Recovery codes are a self-custody (keypair) primitive — soft/custodial
    // (email) identities have no genesis key to ever lose.
    if (session.tier === 'soft') {
      return NextResponse.json(
        { error: 'Recovery codes require a self-custody identity' },
        { status: 403, headers: cors },
      );
    }

    // Regeneration is rare and destructive (invalidates the prior set) —
    // rate limit generously but firmly per-DID.
    const rl = rateLimit(`recovery:generate:${session.sub}`, 3, 60 * 60_000);
    if (rl.limited) {
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: rl.retryAfter },
        { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } },
      );
    }

    const body = await request.json().catch(() => ({}));
    const requestedCount = typeof body?.count === 'number' ? body.count : undefined;

    const codes = await generateRecoveryCodes(session.sub, requestedCount);

    return NextResponse.json(
      {
        did: session.sub,
        codes,
        count: codes.length,
        generatedAt: new Date().toISOString(),
        disclosure: RECOVERY_DISCLOSURE,
        warning: 'Store these codes somewhere safe offline — they will not be shown again, and generating a new set invalidates these.',
      },
      { headers: cors },
    );
  } catch (error) {
    log.error({ err: String(error) }, '[recovery-codes/generate] POST error');
    return NextResponse.json({ error: 'Failed to generate recovery codes' }, { status: 500, headers: cors });
  }
});
