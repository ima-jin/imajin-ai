import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { db, podMembers } from '@/db';
import { eq, and } from 'drizzle-orm';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json();

  const [member] = await db.insert(podMembers).values({
    podId: params.id,
    did: body.did,
    role: body.role || 'member',
    addedBy: auth.identity.id,
    joinedAt: new Date(),
  }).returning();

  return NextResponse.json({ member }, { status: 201 });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json();

  const [removed] = await db
    .update(podMembers)
    .set({ removedAt: new Date() })
    .where(and(eq(podMembers.podId, params.id), eq(podMembers.did, body.did)))
    .returning();

  if (!removed) return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  return NextResponse.json({ removed: true });
}
