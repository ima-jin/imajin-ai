import { NextRequest, NextResponse } from 'next/server';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL!;

/**
 * GET /api/session - Get current session from cookie
 * Verifies JWT via auth service, then fetches profile
 */
export async function GET(request: NextRequest) {
  const sessionCookie = request.cookies.get('imajin_session')?.value;

  if (!sessionCookie) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    // Verify JWT with auth service
    const authRes = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: `imajin_session=${sessionCookie}` },
    });

    if (!authRes.ok) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const authData = await authRes.json();
    const did = authData.identity?.did || authData.identity?.id || authData.did || authData.sub;

    if (!did) {
      return NextResponse.json({ error: 'No DID in session' }, { status: 401 });
    }

    // Fetch profile to get handle/display info
    const profileRes = await fetch(`${PROFILE_SERVICE_URL}/api/profile/${encodeURIComponent(did)}`);
    
    if (!profileRes.ok) {
      return NextResponse.json({ 
        identity: { id: did, type: authData.identity?.type || 'human' }
      });
    }

    const profile = await profileRes.json();
    return NextResponse.json({
      identity: {
        id: did,
        handle: profile.handle || authData.identity?.handle,
        name: profile.name || authData.identity?.name,
        type: profile.type || authData.identity?.type || 'human',
      }
    });
  } catch (error) {
    console.error('Session check error:', error);
    return NextResponse.json({ error: 'Session check failed' }, { status: 500 });
  }
}
