import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { generateId } from '@/src/lib/kernel/id';
import { db, calendarEntries } from '@/src/db';
import { and, eq, gte, lte, gt, isNull, or, desc } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { ENTRY_TYPES, VISIBILITIES, enforceTypeDefaults, publishCalendarEntry, syncCalendarConnectionGrant } from '@/src/lib/calendar';

const log = createLogger('kernel');

/**
 * GET /calendar/api/entries — list the caller's own entries.
 * Filters: ?type=, ?from=ISO, ?to=ISO (by starts_at), ?active=true (not expired).
 */
export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const did = auth.identity.actingAs || auth.identity.id;
  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const active = url.searchParams.get('active') === 'true';

  const conditions = [eq(calendarEntries.did, did)];
  if (type) conditions.push(eq(calendarEntries.type, type));
  if (from) conditions.push(gte(calendarEntries.startsAt, new Date(from)));
  if (to) conditions.push(lte(calendarEntries.startsAt, new Date(to)));
  if (active) {
    const notExpired = or(isNull(calendarEntries.expiresAt), gt(calendarEntries.expiresAt, new Date()));
    if (notExpired) conditions.push(notExpired);
  }

  const entries = await db
    .select()
    .from(calendarEntries)
    .where(and(...conditions))
    .orderBy(desc(calendarEntries.startsAt));

  return NextResponse.json({ entries });
}

/**
 * POST /calendar/api/entries — create a calendar entry owned by the caller.
 * Sealed by default: visibility defaults to 'private', nothing surfaces on create.
 */
export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const did = auth.identity.actingAs || auth.identity.id;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const type = typeof body.type === 'string' ? body.type : null;
  if (!type || !ENTRY_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `type required, one of: ${ENTRY_TYPES.join(', ')}` },
      { status: 400 }
    );
  }

  const callerVisibility = typeof body.visibility === 'string' ? body.visibility : 'private';
  if (!VISIBILITIES.includes(callerVisibility)) {
    return NextResponse.json(
      { error: `visibility must be one of: ${VISIBILITIES.join(', ')}` },
      { status: 400 }
    );
  }

  const typeDefaults = enforceTypeDefaults(type, body, callerVisibility);
  const visibility = typeDefaults.visibility;
  // visibilityDids: type-derived value wins (e.g. meeting participantDids);
  // fall back to caller-supplied visibilityDids for types that don't drive it.
  const visibilityDids =
    typeDefaults.visibilityDids ??
    (Array.isArray(body.visibilityDids) ? (body.visibilityDids as string[]) : null);

  const id = generateId('cal');

  const [entry] = await db
    .insert(calendarEntries)
    .values({
      id,
      did,
      type,
      title: typeof body.title === 'string' ? body.title : null,
      activityTags: Array.isArray(body.activityTags) ? (body.activityTags as string[]) : null,
      startsAt: body.startsAt ? new Date(body.startsAt as string) : null,
      endsAt: body.endsAt ? new Date(body.endsAt as string) : null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt as string) : null,
      visibility,
      visibilityDids,
      recurrence: body.recurrence ?? null,
      metadata: (body.metadata as Record<string, unknown>) ?? {},
    })
    .returning();

  // Fire and forget — never block the response.
  publishCalendarEntry('calendar.entry.created', auth.identity.id, did, entry.id, entry.type, log);
  // Sync connection grant: if this entry is connections-visible, ensure a
  // grantedToClass grant exists so broker queries can release it (#1189).
  syncCalendarConnectionGrant(did, 'calendar.entry', auth.identity.id, log);

  return NextResponse.json({ entry }, { status: 201 });
}
