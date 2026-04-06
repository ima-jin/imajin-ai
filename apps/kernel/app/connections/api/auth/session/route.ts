import { NextRequest, NextResponse } from 'next/server';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export async function GET(request: NextRequest) {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: request.headers.get('cookie') || '' },
    });

    if (!response.ok) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Auth session proxy error:', error);
    return NextResponse.json({ error: 'Auth service unavailable' }, { status: 502 });
  }
}
