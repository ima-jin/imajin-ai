import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { db, pods, podMembers } from '@/db';
import { eq, and, isNull } from 'drizzle-orm';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });

  const members = await db
    .select()
    .from(podMembers)
    .where(and(eq(podMembers.podId, params.id), isNull(podMembers.removedAt)));

  return NextResponse.json({ pod, members });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json();
  const [updated] = await db
    .update(pods)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(pods.id, params.id), eq(pods.ownerDid, auth.identity.id)))
    .returning();

  if (!updated) return NextResponse.json({ error: 'Pod not found or unauthorized' }, { status: 404 });
  return NextResponse.json({ pod: updated });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [deleted] = await db
    .delete(pods)
    .where(and(eq(pods.id, params.id), eq(pods.ownerDid, auth.identity.id)))
    .returning();

  if (!deleted) return NextResponse.json({ error: 'Pod not found or unauthorized' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
