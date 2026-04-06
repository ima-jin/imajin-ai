import { SESSION_COOKIE_NAME } from "@imajin/config";
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import { db, profiles } from '@/src/db';
import { or, eq } from 'drizzle-orm';

/**
 * GET /api/session - Get current session from cookie
 * Verifies JWT via direct DB check, then fetches profile
 */
export async function GET(request: NextRequest) {
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!sessionCookie) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const session = await getSessionFromCookies(request.headers.get('cookie'));

    if (!session) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const did = session.did;

    // Fetch profile to get handle/display info
    const profile = await db.query.profiles.findFirst({
      where: (p, { or, eq }) => or(eq(p.did, did), eq(p.handle, did)),
    });

    if (!profile) {
      return NextResponse.json({
        identity: { id: did, type: session.type }
      });
    }

    return NextResponse.json({
      identity: {
        id: did,
        handle: profile.handle || session.handle,
        name: profile.displayName || session.name,
        type: profile.displayType || session.type,
      }
    });
  } catch (error) {
    console.error('Session check error:', error);
    return NextResponse.json({ error: 'Session check failed' }, { status: 500 });
  }
}
