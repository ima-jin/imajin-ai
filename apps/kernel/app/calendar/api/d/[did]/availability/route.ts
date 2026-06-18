import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { broker, isBrokerRelease } from '@imajin/bus';
import { db, calendarEntries } from '@/src/db';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { CalendarEntry } from '@/src/db';

/**
 * GET /calendar/api/d/[did]/availability — query another identity's availability.
 *
 * Visibility model (Issue #241):
 *  - self            → see everything
 *  - public entries  → returned directly to anyone
 *  - non-public      → gated through bus.broker() (consent → scope → release → audit)
 *
 * NOTE: reach-ring / relationship-class consent (favourites | 1° | strangers) is
 * NOT resolved here — that lands with #1099 (availability intent) and #1049
 * (consent grants). Until a consent config admits the requester, the broker
 * fail-closes, so non-public entries stay sealed and nothing is disclosed. This
 * is the intended humane default; the hook is wired and every request is audited.
 */

/** Minimal disclosure surface for someone else's entry — never leaks owner-only fields. */
function project(entry: CalendarEntry) {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    activityTags: entry.activityTags,
    startsAt: entry.startsAt,
    endsAt: entry.endsAt,
  };
}

export async function GET(request: Request, { params }: { params: { did: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const requesterDid = auth.identity.actingFor || auth.identity.actingAs || auth.identity.id;
  const targetDid = params.did;

  // Only active (non-expired) entries are queryable.
  const notExpired = or(isNull(calendarEntries.expiresAt), gt(calendarEntries.expiresAt, new Date()));
  const entries = await db
    .select()
    .from(calendarEntries)
    .where(and(eq(calendarEntries.did, targetDid), notExpired!));

  // Self-query: full visibility.
  if (requesterDid === targetDid) {
    return NextResponse.json({ entries });
  }

  const publicEntries = entries.filter((e) => e.visibility === 'public');
  const gatedEntries = entries.filter((e) => e.visibility !== 'public');

  const disclosed = publicEntries.map(project);

  // Gate non-public entries through the broker. Fail-closed by default.
  if (gatedEntries.length > 0) {
    const result = await broker('calendar.availability.request', {
      type: 'calendar.availability.request',
      requester: requesterDid,
      subject: targetDid,
      fields: ['availability'],
      purpose: 'calendar.availability',
      scope: 'calendar',
      data: { availability: gatedEntries.map(project) },
    });

    if (isBrokerRelease(result) && Array.isArray(result.data.availability)) {
      disclosed.push(...(result.data.availability as ReturnType<typeof project>[]));
    }
  }

  return NextResponse.json({ entries: disclosed });
}
