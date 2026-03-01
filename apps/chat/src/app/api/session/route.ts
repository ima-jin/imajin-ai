import { NextRequest, NextResponse } from 'next/server';

const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL!;

/**
 * GET /api/session - Get current session from cookie
 * Reads DID from imajin_session cookie, fetches profile
 */
export async function GET(request: NextRequest) {
  const sessionCookie = request.cookies.get('imajin_session')?.value;

  if (!sessionCookie) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const did = sessionCookie;

  try {
    // Fetch profile to get handle/display info
    const response = await fetch(`${PROFILE_SERVICE_URL}/api/profile/${encodeURIComponent(did)}`);
    
    if (!response.ok) {
      return NextResponse.json({ 
        identity: { id: did, type: 'human' }
      });
    }

    const profile = await response.json();
    return NextResponse.json({
      identity: {
        id: did,
        handle: profile.handle,
        name: profile.name,
        type: profile.type || 'human',
      }
    });
  } catch (error) {
    // Even if profile fetch fails, the cookie DID is valid
    return NextResponse.json({ 
      identity: { id: did, type: 'human' }
    });
  }
}
