import { SESSION_COOKIE_NAME } from "@imajin/config";
import { NextRequest, NextResponse } from 'next/server';
import { getUsageStats } from '@/lib/metering';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:7001';

/**
 * GET /api/usage
 * 
 * Returns current rate limit usage for the authenticated DID.
 */
export async function GET(request: NextRequest) {
  // Validate session
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  try {
    const sessionRes = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
    });
    if (!sessionRes.ok) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }
    const session = await sessionRes.json();
    const did = session.did || session.sub;

    if (!did) {
      return NextResponse.json({ error: 'No DID in session' }, { status: 401 });
    }

    return NextResponse.json({
      did,
      usage: getUsageStats(did),
    });
  } catch {
    return NextResponse.json({ error: 'Auth service unavailable' }, { status: 503 });
  }
}
