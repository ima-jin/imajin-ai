import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

/**
 * POST /api/auth/register - Proxy to auth service
 * This allows same-origin cookie setting from the browser
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Forward request to auth service
    const response = await fetch(`${AUTH_SERVICE_URL}/api/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    // Create Next.js response with the auth data
    const nextResponse = NextResponse.json(data, { status: response.status });

    // Forward the Set-Cookie header from auth service
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      nextResponse.headers.set('Set-Cookie', setCookie);
    }

    return nextResponse;
  } catch (error) {
    console.error('Auth register proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to connect to auth service' },
      { status: 500 }
    );
  }
}
