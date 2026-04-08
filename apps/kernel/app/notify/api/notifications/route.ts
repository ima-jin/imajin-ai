import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { requireAuth } from '@imajin/auth';
import { db } from '@/src/db';
import { notifications } from '@/src/db';
import { eq, and, lt, desc } from 'drizzle-orm';

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

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);
  const before = searchParams.get('before');

  const conditions = [eq(notifications.recipientDid, did)];
  if (before) {
    conditions.push(lt(notifications.id, before));
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  return NextResponse.json({ notifications: rows }, { headers: cors });
}
