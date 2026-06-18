import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { db, calendarEntries } from '@/src/db';
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { VISIBILITIES, publishCalendarEntry } from '@/src/lib/calendar';

const log = createLogger('kernel');

/**
 * PATCH /calendar/api/entries/[id] — update an entry the caller owns.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const did = auth.identity.actingAs || auth.identity.id;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body.visibility === 'string' && !VISIBILITIES.includes(body.visibility)) {
    return NextResponse.json(
      { error: `visibility must be one of: ${VISIBILITIES.join(', ')}` },
      { status: 400 }
    );
  }

  // Whitelist updatable fields; coerce timestamps from ISO strings.
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if ('title' in body) updates.title = body.title;
  if ('activityTags' in body) updates.activityTags = body.activityTags;
  if ('startsAt' in body) updates.startsAt = body.startsAt ? new Date(body.startsAt as string) : null;
  if ('endsAt' in body) updates.endsAt = body.endsAt ? new Date(body.endsAt as string) : null;
  if ('expiresAt' in body) updates.expiresAt = body.expiresAt ? new Date(body.expiresAt as string) : null;
  if ('visibility' in body) updates.visibility = body.visibility;
  if ('visibilityDids' in body) updates.visibilityDids = body.visibilityDids;
  if ('recurrence' in body) updates.recurrence = body.recurrence;
  if ('metadata' in body) updates.metadata = body.metadata;

  const [updated] = await db
    .update(calendarEntries)
    .set(updates)
    .where(and(eq(calendarEntries.id, params.id), eq(calendarEntries.did, did)))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: 'Entry not found or unauthorized' }, { status: 404 });
  }

  publishCalendarEntry('calendar.entry.updated', auth.identity.id, did, updated.id, updated.type, log);

  return NextResponse.json({ entry: updated });
}

/**
 * DELETE /calendar/api/entries/[id] — delete an entry the caller owns.
 */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const did = auth.identity.actingAs || auth.identity.id;

  const [deleted] = await db
    .delete(calendarEntries)
    .where(and(eq(calendarEntries.id, params.id), eq(calendarEntries.did, did)))
    .returning();

  if (!deleted) {
    return NextResponse.json({ error: 'Entry not found or unauthorized' }, { status: 404 });
  }

  publishCalendarEntry('calendar.entry.deleted', auth.identity.id, did, deleted.id, deleted.type, log);

  return NextResponse.json({ deleted: true });
}
