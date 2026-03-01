import { NextRequest, NextResponse } from 'next/server';

const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL!;

/**
 * GET /api/profile?handle=xxx - Proxy to profile service
 * Used by new chat flow to search users
 */
export async function GET(request: NextRequest) {
  const handle = request.nextUrl.searchParams.get('handle');

  if (!handle) {
    return NextResponse.json({ error: 'handle parameter required' }, { status: 400 });
  }

  try {
    const response = await fetch(`${PROFILE_SERVICE_URL}/api/profile/${encodeURIComponent(handle)}`);

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Profile lookup failed' }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Profile lookup failed:', error);
    return NextResponse.json({ error: 'Profile service unavailable' }, { status: 503 });
  }
}
