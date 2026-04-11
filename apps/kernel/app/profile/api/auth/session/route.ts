import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import { withLogger } from '@imajin/logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/session - Direct session check via kernel session lib
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  try {
    const session = await getSessionFromCookies(request.headers.get('cookie'));

    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    return NextResponse.json(session);
  } catch (error) {
    log.error({ err: String(error) }, 'Auth session proxy error');
    return NextResponse.json(
      { error: 'Failed to get session' },
      { status: 500 }
    );
  }
});
