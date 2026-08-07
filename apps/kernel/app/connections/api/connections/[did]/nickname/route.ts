import { NextRequest, NextResponse } from 'next/server';
import { db, nicknames } from '@/src/db';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { eq, and } from 'drizzle-orm';

export async function GET(request: NextRequest, props: { params: Promise<{ did: string }> }) {
  const params = await props.params;
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity } = authResult;
  const did = resolveActingDid(identity);

  const { did: targetDid } = params;

  const [row] = await db
    .select()
    .from(nicknames)
    .where(and(eq(nicknames.did, did), eq(nicknames.target, targetDid)));

  return NextResponse.json({ nickname: row?.nickname ?? null });
}

export async function PATCH(request: NextRequest, props: { params: Promise<{ did: string }> }) {
  const params = await props.params;
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity } = authResult;
  const did = resolveActingDid(identity);

  const { did: targetDid } = params;
  const { nickname } = await request.json();

  await db
    .insert(nicknames)
    .values({ did, target: targetDid, nickname })
    .onConflictDoUpdate({
      target: [nicknames.did, nicknames.target],
      set: { nickname },
    });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ did: string }> }) {
  const params = await props.params;
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity } = authResult;
  const did = resolveActingDid(identity);

  const { did: targetDid } = params;

  await db
    .delete(nicknames)
    .where(and(eq(nicknames.did, did), eq(nicknames.target, targetDid)));

  return NextResponse.json({ ok: true });
}
