import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

/**
 * GET /api/auth/session - Proxy to auth service session check
 * Forwards the imajin_session cookie to auth service
 */
export async function GET(request: NextRequest) {
  try {
    const cookie = request.cookies.get('imajin_session');

    // Forward request to auth service with cookie
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (cookie) {
      headers['Cookie'] = `${cookie.name}=${cookie.value}`;
    }

    const response = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      method: 'GET',
      headers,
    });

    const data = await response.json();

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Auth session proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to connect to auth service' },
      { status: 500 }
    );
  }
}
