import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { db, calendarEntries } from '@/src/db';
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const VISIBILITIES = ['public', 'connections', 'selective', 'private'];

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

  publish('calendar.entry.updated', {
    issuer: auth.identity.id,
    subject: did,
    scope: 'calendar',
    payload: { entryId: updated.id, type: updated.type, did, context_id: updated.id, context_type: 'calendar' },
  }).catch((err: unknown) => log.error({ err: String(err) }, 'calendar.entry.updated emit error'));

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

  publish('calendar.entry.deleted', {
    issuer: auth.identity.id,
    subject: did,
    scope: 'calendar',
    payload: { entryId: deleted.id, type: deleted.type, did, context_id: deleted.id, context_type: 'calendar' },
  }).catch((err: unknown) => log.error({ err: String(err) }, 'calendar.entry.deleted emit error'));

  return NextResponse.json({ deleted: true });
}
