import { NextRequest, NextResponse } from 'next/server';
import { db, nicknames } from '../../../../src/db/index';
import { corsHeaders, corsOptions, withCors } from '@/src/lib/connections/cors';
import { requireAuth } from '@imajin/auth';
import { eq, and, inArray } from 'drizzle-orm';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  const did = identity.actingAs || identity.id;

  const body = await request.json();
  const dids: string[] = body.dids ?? [];

  if (dids.length === 0) {
    return withCors(NextResponse.json({ nicknames: {} }), request);
  }

  const rows = await db
    .select({ target: nicknames.target, nickname: nicknames.nickname })
    .from(nicknames)
    .where(and(eq(nicknames.did, did), inArray(nicknames.target, dids)));

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.target] = row.nickname;
  }

  return withCors(NextResponse.json({ nicknames: result }), request);
}
