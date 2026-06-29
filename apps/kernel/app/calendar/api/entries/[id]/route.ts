import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { db, calendarEntries } from '@/src/db';
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { VISIBILITIES, publishCalendarEntry, syncCalendarConnectionGrant } from '@/src/lib/calendar';

const log = createLogger('kernel');

/** Coerce an ISO string field to Date, or null if absent/falsy. */
function toDate(val: unknown): Date | null {
  return val ? new Date(val as string) : null;
}

/** Extract whitelisted fields from a PATCH body into a DB update map. */
function parseEntryUpdates(body: Record<string, unknown>): Record<string, unknown> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const scalar = ['title', 'activityTags', 'visibility', 'visibilityDids', 'recurrence', 'metadata'] as const;
  for (const key of scalar) {
    if (key in body) updates[key] = body[key];
  }
  if ('startsAt' in body) updates.startsAt = toDate(body.startsAt);
  if ('endsAt' in body) updates.endsAt = toDate(body.endsAt);
  if ('expiresAt' in body) updates.expiresAt = toDate(body.expiresAt);
  return updates;
}

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

  const [updated] = await db
    .update(calendarEntries)
    .set(parseEntryUpdates(body))
    .where(and(eq(calendarEntries.id, params.id), eq(calendarEntries.did, did)))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: 'Entry not found or unauthorized' }, { status: 404 });
  }

  publishCalendarEntry('calendar.entry.updated', auth.identity.id, did, updated.id, updated.type, log);
  // Visibility may have changed — reconcile the connection grant.
  syncCalendarConnectionGrant(did, 'calendar.entry', auth.identity.id, log);

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
  // Entry removed — revoke the connection grant if no connections-visibility
  // entries remain for this owner.
  syncCalendarConnectionGrant(did, 'calendar.entry', auth.identity.id, log);

  return NextResponse.json({ deleted: true });
}
