import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { requireAuth } from '@/src/lib/auth/middleware';
import { getRecoveryCodeStatus } from '@/src/lib/auth/recovery-codes';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /auth/api/recovery-codes/status
 *
 * Session-authenticated. Reports how many recovery codes are currently
 * active for the caller's own identity and when they were generated — never
 * the codes themselves (they are shown exactly once, at generation time).
 *
 * Returns: { did, remaining: number, generatedAt: string | null }
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const session = await requireAuth(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
    }

    const status = await getRecoveryCodeStatus(session.sub);

    return NextResponse.json({ did: session.sub, ...status }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, '[recovery-codes/status] GET error');
    return NextResponse.json({ error: 'Failed to retrieve recovery code status' }, { status: 500, headers: cors });
  }
});
