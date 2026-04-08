import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import { checkAccess } from '@/src/lib/kernel/access';

/**
 * GET /api/access/[did] - Direct access check (replaces proxy to auth service).
 *
 * The @imajin/chat useChatAccess hook calls this from the browser.
 * Cross-origin cookie forwarding is unreliable, so we proxy through the chat app's
 * own origin and forward the session cookie server-to-server.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { did: string } }
) {
  const session = await getSessionFromCookies(request.headers.get('cookie'));

  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const did = decodeURIComponent(params.did);
    const result = await checkAccess(session.did, did);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Access check error:', error);
    return NextResponse.json({ error: 'Access check failed' }, { status: 500 });
  }
}
