import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { db, calendarEntries } from '@/src/db';
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * DELETE /calendar/api/availability/[id] — cancel an availability intent the caller owns.
 *
 * Only the owner can cancel their own intent. Sealed entries are never accessible
 * to non-owners; this route enforces owner-only scoping via did match in the WHERE clause.
 * The note dies sealed — nobody ever knew it existed.
 */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const did = auth.identity.actingAs || auth.identity.id;

  const [deleted] = await db
    .delete(calendarEntries)
    .where(
      and(
        eq(calendarEntries.id, params.id),
        eq(calendarEntries.did, did),
        eq(calendarEntries.type, 'availability')
      )
    )
    .returning();

  if (!deleted) {
    return NextResponse.json({ error: 'Intent not found or unauthorized' }, { status: 404 });
  }

  publish('calendar.entry.deleted', {
    issuer: auth.identity.id,
    subject: did,
    scope: 'calendar',
    payload: { entryId: deleted.id, type: 'availability', did, context_id: deleted.id, context_type: 'calendar' },
  }).catch((err: unknown) => log.error({ err: String(err) }, 'availability intent deleted emit error'));

  return NextResponse.json({ cancelled: true });
}
