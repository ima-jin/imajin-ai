import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { requireAuth } from '@imajin/auth';
import { db, groupControllers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity: caller } = authResult;

  let body: { did?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { did } = body;

  // null = return to personal identity
  if (did === null || did === undefined) {
    const response = NextResponse.json({ ok: true, actingAs: null }, { headers: cors });
    response.cookies.set('x-acting-as', '', { path: '/', maxAge: 0, sameSite: 'lax' });
    return response;
  }

  try {
    const controllers = await db
      .select({ controllerDid: groupControllers.controllerDid })
      .from(groupControllers)
      .where(
        and(
          eq(groupControllers.groupDid, did),
          eq(groupControllers.controllerDid, caller.id),
          isNull(groupControllers.removedAt)
        )
      )
      .limit(1);

    if (controllers.length === 0) {
      return NextResponse.json(
        { error: 'Not authorized to act as this identity' },
        { status: 403, headers: cors }
      );
    }

    const response = NextResponse.json({ ok: true, actingAs: did }, { headers: cors });
    response.cookies.set('x-acting-as', did, { path: '/', maxAge: 31536000, sameSite: 'lax' });
    return response;
  } catch (error) {
    log.error({ err: String(error) }, '[act-as] Error switching identity');
    return NextResponse.json({ error: 'Failed to switch identity' }, { status: 500, headers: cors });
  }
});
