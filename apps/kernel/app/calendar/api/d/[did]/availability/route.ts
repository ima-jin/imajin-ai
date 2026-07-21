import { NextResponse } from 'next/server';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { db, calendarEntries } from '@/src/db';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { filterAndGateEntries } from '@/src/lib/calendar';

const log = createLogger('kernel');

/**
 * GET /calendar/api/d/[did]/availability — query another identity's availability.
 *
 * Visibility model (Issue #241):
 *  - self       → see everything
 *  - public     → returned directly to anyone
 *  - selective  → inline visibilityDids check, no broker call
 *  - connections → broker-gated (calendar.availability.request) — fail-closes
 *                  until consent grants (#1049) + reach-ring resolution (#1189) land
 *  - private / sealed → never disclosed to non-owner; never touch broker
 */
export async function GET(request: Request, { params }: { params: { did: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const requesterDid = auth.identity.actingFor || resolveActingDid(auth.identity);
  const targetDid = params.did;

  // Only active (non-expired) entries are queryable.
  const notExpired = or(isNull(calendarEntries.expiresAt), gt(calendarEntries.expiresAt, new Date()));
  const entries = await db
    .select()
    .from(calendarEntries)
    .where(and(eq(calendarEntries.did, targetDid), notExpired));

  // Self-query: full visibility, no gating.
  if (requesterDid === targetDid) {
    return NextResponse.json({ entries });
  }

  const disclosed = await filterAndGateEntries(
    entries,
    requesterDid,
    targetDid,
    'calendar.availability.request',
    'calendar.availability',
    log,
  );

  return NextResponse.json({ entries: disclosed });
}
