import { SESSION_COOKIE_NAME } from "@imajin/config";
import { NextRequest, NextResponse } from 'next/server';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

/**
 * GET /api/access/[did] - Proxy access check to auth service (server-to-server).
 *
 * The @imajin/chat useChatAccess hook calls authUrl/api/access/:did from the browser.
 * Cross-origin cookie forwarding is unreliable, so we proxy through the chat app's
 * own origin and forward the session cookie server-to-server.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { did: string } }
) {
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!sessionCookie) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const did = decodeURIComponent(params.did);
    const res = await fetch(
      `${AUTH_SERVICE_URL}/api/access/${encodeURIComponent(did)}`,
      {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        },
      }
    );

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error('Access proxy error:', error);
    return NextResponse.json({ error: 'Access check failed' }, { status: 500 });
  }
}
