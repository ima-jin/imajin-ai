import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/src/lib/kernel/session';

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionFromCookies(request.headers.get('cookie'));

    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    return NextResponse.json(session);
  } catch (error) {
    console.error('Auth session proxy error:', error);
    return NextResponse.json({ error: 'Auth service unavailable' }, { status: 502 });
  }
}
