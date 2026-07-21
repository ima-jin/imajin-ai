import { NextResponse } from 'next/server';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { db, calendarEntries } from '@/src/db';
import { and, eq, gte, gt, isNull, lte, or } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { ENTRY_TYPES, filterAndGateEntries } from '@/src/lib/calendar';

const log = createLogger('kernel');

/**
 * GET /calendar/api/d/[did]/entries — broker-gated read of another identity's calendar entries.
 *
 * Filters: ?type=meeting|booking|... ?from=ISO ?to=ISO (by starts_at)
 *
 * Visibility model (Issue #241, #1188):
 *  - self       → see everything
 *  - public     → returned directly to anyone
 *  - selective  → inline visibilityDids check, no broker call
 *  - connections → broker-gated (calendar.entry.request) — fail-closes
 *                  until consent grants (#1049) + reach-ring resolution (#1189) land
 *  - private / sealed → never disclosed to non-owner; never touch broker
 */
export async function GET(request: Request, { params }: { params: { did: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const requesterDid = auth.identity.actingFor || resolveActingDid(auth.identity);
  const targetDid = params.did;

  const url = new URL(request.url);
  const typeFilter = url.searchParams.get('type');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (typeFilter && !ENTRY_TYPES.includes(typeFilter)) {
    return NextResponse.json(
      { error: `type must be one of: ${ENTRY_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  const notExpired = or(isNull(calendarEntries.expiresAt), gt(calendarEntries.expiresAt, new Date()));
  const conditions = [eq(calendarEntries.did, targetDid), notExpired];
  if (typeFilter) conditions.push(eq(calendarEntries.type, typeFilter));
  if (from) conditions.push(gte(calendarEntries.startsAt, new Date(from)));
  if (to) conditions.push(lte(calendarEntries.startsAt, new Date(to)));

  const entries = await db
    .select()
    .from(calendarEntries)
    .where(and(...conditions));

  // Self-query: full visibility, no gating.
  if (requesterDid === targetDid) {
    return NextResponse.json({ entries });
  }

  const disclosed = await filterAndGateEntries(
    entries,
    requesterDid,
    targetDid,
    'calendar.entry.request',
    'calendar.entry',
    log,
  );

  return NextResponse.json({ entries: disclosed });
}
