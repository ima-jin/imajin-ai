/**
 * GET /api/onboard/poll?handle=xxx
 *
 * Poll for verification status of an onboard token.
 * Returns: { status: 'pending' | 'completed' | 'claimed' | 'expired', handoffToken? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, onboardTokens } from '@/src/db';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { rateLimit, getClientIP } from '@/src/lib/kernel/rate-limit';
import { withLogger } from '@imajin/logger';

const HANDOFF_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 30, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const handle = request.nextUrl.searchParams.get('handle');
    if (!handle) {
      return NextResponse.json(
        { error: 'handle is required' },
        { status: 400, headers: cors }
      );
    }

    const [record] = await db
      .select()
      .from(onboardTokens)
      .where(eq(onboardTokens.pollHandle, handle))
      .limit(1);

    if (!record) {
      return NextResponse.json(
        { status: 'expired' },
        { headers: cors }
      );
    }

    // Token expired (past its 15-min TTL)
    if (new Date(record.expiresAt) < new Date()) {
      return NextResponse.json(
        { status: 'expired' },
        { headers: cors }
      );
    }

    // Not yet used — buyer hasn't clicked the email link
    if (!record.usedAt) {
      return NextResponse.json(
        { status: 'pending' },
        { headers: cors }
      );
    }

    // Already claimed
    if (record.handoffUsedAt) {
      return NextResponse.json(
        { status: 'claimed' },
        { headers: cors }
      );
    }

    // Handoff token exists but may be expired
    if (record.handoffToken) {
      const handoffAge = Date.now() - new Date(record.usedAt).getTime();
      if (handoffAge > HANDOFF_TTL_MS) {
        return NextResponse.json(
          { status: 'expired' },
          { headers: cors }
        );
      }
      return NextResponse.json(
        { status: 'completed', handoffToken: record.handoffToken },
        { headers: cors }
      );
    }

    // Used but no handoff token (shouldn't happen with polling flows)
    return NextResponse.json(
      { status: 'expired' },
      { headers: cors }
    );

  } catch (error) {
    log.error({ err: String(error) }, 'Onboard poll error');
    return NextResponse.json(
      { error: 'Failed to poll status' },
      { status: 500, headers: cors }
    );
  }
});
