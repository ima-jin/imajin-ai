import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import { withLogger } from '@imajin/logger';

export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  try {
    const session = await getSessionFromCookies(request.headers.get('cookie'));

    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    return NextResponse.json(session);
  } catch (error) {
    log.error({ err: String(error) }, 'Auth session proxy error');
    return NextResponse.json({ error: 'Auth service unavailable' }, { status: 502 });
  }
});
