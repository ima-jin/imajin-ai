import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { db, events } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { eq } from 'drizzle-orm';
import { validateManifest } from '@imajin/fair';

/**
 * PATCH /api/events/[id]/fair - Update the .fair manifest for an event
 * Requires auth as creator or admin.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const { id } = await params;

  try {
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const orgCheck = await isEventOrganizer(id, identity.id);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Not authorized to update this event' }, { status: 403 });
    }

    const body = await request.json();
    const { manifest } = body;

    const { valid, errors } = validateManifest(manifest);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid .fair manifest', errors }, { status: 400 });
    }

    const updatedMetadata = { ...(event.metadata as Record<string, unknown> || {}), fair: manifest };

    const [updated] = await db
      .update(events)
      .set({ metadata: updatedMetadata, updatedAt: new Date() })
      .where(eq(events.id, id))
      .returning();

    revalidatePath(`/${id}`);

    return NextResponse.json({ event: updated, manifest });
  } catch (error) {
    console.error('Failed to update .fair manifest:', error);
    return NextResponse.json({ error: 'Failed to update manifest' }, { status: 500 });
  }
}
