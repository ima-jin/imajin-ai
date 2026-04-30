import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { requireAuth } from '@imajin/auth';
import { db, identityMembers } from '@/src/db';
import { eq, and, isNull, inArray } from 'drizzle-orm';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

const ACT_AS_ROLES = ['owner', 'admin', 'maintainer'];

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
    const members = await db
      .select({ memberDid: identityMembers.memberDid })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, did),
          eq(identityMembers.memberDid, caller.id),
          inArray(identityMembers.role, ACT_AS_ROLES),
          isNull(identityMembers.removedAt)
        )
      )
      .limit(1);

    if (members.length === 0) {
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
