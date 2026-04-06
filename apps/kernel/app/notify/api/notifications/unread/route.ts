import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { requireAuth } from '@imajin/auth';
import { db } from '@/src/db';
import { notifications } from '@/src/db';
import { eq, and, count } from 'drizzle-orm';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  const did = identity.actingAs || identity.id;

  const [result] = await db
    .select({ count: count() })
    .from(notifications)
    .where(and(eq(notifications.recipientDid, did), eq(notifications.read, false)));

  return NextResponse.json({ count: result?.count ?? 0 }, { headers: cors });
}
