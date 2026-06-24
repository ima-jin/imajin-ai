import { NextResponse } from 'next/server';
import { requireAuth, requireAppAuth, resolveActingDid } from '@imajin/auth';
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
  let issuerId: string;
  let did: string;

  // App-auth path: service token (broker-agent acting on behalf of a user)
  const appAuthResult = await requireAppAuth(request, { scope: 'availability:write' });
  if ('appAuth' in appAuthResult) {
    const actingFor = request.headers.get('x-acting-for');
    if (!actingFor) {
      return NextResponse.json({ error: 'X-Acting-For header required for app auth' }, { status: 400 });
    }
    issuerId = appAuthResult.appAuth.appDid;
    did = actingFor;
  } else {
    // Session auth path: cookie or session Bearer token
    const auth = await requireAuth(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
    issuerId = auth.identity.id;
    did = resolveActingDid(auth.identity);
  }

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
    issuer: issuerId,
    subject: did,
    scope: 'calendar',
    payload: { entryId: deleted.id, type: 'availability', did, context_id: deleted.id, context_type: 'calendar' },
  }).catch((err: unknown) => log.error({ err: String(err) }, 'availability intent deleted emit error'));

  return NextResponse.json({ cancelled: true });
}
