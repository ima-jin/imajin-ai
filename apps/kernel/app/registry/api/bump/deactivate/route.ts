import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { requireAuth } from '@imajin/auth';
import { db, bumpSessions } from '@/src/db';
import { and, eq } from 'drizzle-orm';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /registry/api/bump/deactivate
 * Close a bump session.
 */
export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  let body: { sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { sessionId } = body;
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400, headers: cors });
  }

  const did = authResult.identity.actingAs || authResult.identity.id;

  try {
    const result = await db.update(bumpSessions)
      .set({ deactivatedAt: new Date() })
      .where(and(eq(bumpSessions.id, sessionId), eq(bumpSessions.did, did)))
      .returning({ id: bumpSessions.id });

    if (result.length === 0) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404, headers: cors });
    }

    return NextResponse.json({ ok: true }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, '[bump/deactivate] error');
    return NextResponse.json({ error: 'Failed to deactivate session' }, { status: 500, headers: cors });
  }
});
