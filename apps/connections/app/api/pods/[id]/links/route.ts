import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { db, podLinks } from '@/db';
import { eq, and } from 'drizzle-orm';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json();

  const [link] = await db.insert(podLinks).values({
    parentPodId: params.id,
    childPodId: body.childPodId,
    linkedBy: auth.identity.id,
    linkedAt: new Date(),
  }).returning();

  return NextResponse.json({ link }, { status: 201 });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json();

  const [unlinked] = await db
    .update(podLinks)
    .set({ unlinkedAt: new Date() })
    .where(and(eq(podLinks.parentPodId, params.id), eq(podLinks.childPodId, body.childPodId)))
    .returning();

  if (!unlinked) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  return NextResponse.json({ unlinked: true });
}
