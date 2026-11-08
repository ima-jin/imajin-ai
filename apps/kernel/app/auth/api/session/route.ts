import { withSessionCookie } from '@/src/lib/auth/session-cookie';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { resolveKernelSession } from '@/src/lib/auth/session-resolver';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { databaseTimeoutResponse } from '@/src/lib/auth/database-timeout';

export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const cookieConfig = getSessionCookieOptions();
    const token = request.cookies.get(cookieConfig.name)?.value;

    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401, headers: cors }
      );
    }

    const result = await resolveKernelSession(token);
    if ('error' in result) {
      const response = NextResponse.json(
        { error: result.error },
        { status: 401, headers: cors }
      );
      return withSessionCookie(response, null, cookieConfig);
    }

    return NextResponse.json(result.data, { headers: cors });

  } catch (error) {
    const unavailable = databaseTimeoutResponse(error, cors);
    if (unavailable) return unavailable;
    log.error({ err: String(error) }, 'Session error');
    return NextResponse.json(
      { error: 'Failed to get session' },
      { status: 500, headers: cors }
    );
  }
});

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
