import { NextResponse } from 'next/server';
import { requireAuth, requireAppAuth, resolveActingDid } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { generateId } from '@/src/lib/kernel/id';
import { db, calendarEntries } from '@/src/db';
import { and, eq, gt, isNull, or, desc } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { publishCalendarEntry } from '@/src/lib/calendar';

const log = createLogger('kernel');

const REACH_VALUES = ['favourites', 'one_degree', 'strangers'] as const;
type Reach = typeof REACH_VALUES[number];

/**
 * Resolve a named time window to { starts_at, ends_at, expires_at }.
 * Callers may also pass explicit ISO timestamps instead.
 */
function resolveWindow(window: string): { startsAt: Date; endsAt: Date; expiresAt: Date } {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;

  switch (window) {
    case 'today': {
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return { startsAt: now, endsAt: end, expiresAt: end };
    }
    case 'tonight': {
      const start = new Date(now);
      start.setHours(18, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return { startsAt: start, endsAt: end, expiresAt: end };
    }
    case 'this_weekend': {
      const day_of_week = now.getDay(); // 0=Sun, 6=Sat
      const daysUntilSat = (6 - day_of_week + 7) % 7 || 7;
      const sat = new Date(now.getTime() + daysUntilSat * day);
      sat.setHours(0, 0, 0, 0);
      const sun = new Date(sat.getTime() + day);
      sun.setHours(23, 59, 59, 999);
      return { startsAt: sat, endsAt: sun, expiresAt: sun };
    }
    case 'this_week': {
      const end = new Date(now.getTime() + 7 * day);
      return { startsAt: now, endsAt: end, expiresAt: end };
    }
    case 'next_week': {
      const start = new Date(now.getTime() + 7 * day);
      const end = new Date(now.getTime() + 14 * day);
      return { startsAt: start, endsAt: end, expiresAt: end };
    }
    default:
      throw new Error(`Unknown window shorthand: ${window}. Use 'today', 'tonight', 'this_weekend', 'this_week', 'next_week' or provide explicit timestamps.`);
  }
}

/**
 * GET /calendar/api/availability — list caller's own live (not-expired) availability intents.
 *
 * Auth: session cookie/Bearer (users) OR app-service Bearer with availability:read scope
 * (broker-agent). App path requires X-Acting-For header to identify the target user.
 */
export async function GET(request: Request) {
  // App-auth path: service token (broker-agent acting on behalf of a user)
  const appAuthResult = await requireAppAuth(request, { scope: 'availability:read' });
  if ('appAuth' in appAuthResult) {
    const actingFor = request.headers.get('x-acting-for');
    if (!actingFor) {
      return NextResponse.json({ error: 'X-Acting-For header required for app auth' }, { status: 400 });
    }
    const notExpired = or(isNull(calendarEntries.expiresAt), gt(calendarEntries.expiresAt, new Date()));
    const intents = await db
      .select()
      .from(calendarEntries)
      .where(and(eq(calendarEntries.did, actingFor), eq(calendarEntries.type, 'availability'), notExpired))
      .orderBy(desc(calendarEntries.expiresAt));
    return NextResponse.json({ intents });
  }

  // Session auth path: cookie or session Bearer token
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const did = resolveActingDid(auth.identity);
  const notExpired = or(isNull(calendarEntries.expiresAt), gt(calendarEntries.expiresAt, new Date()));

  const intents = await db
    .select()
    .from(calendarEntries)
    .where(and(eq(calendarEntries.did, did), eq(calendarEntries.type, 'availability'), notExpired))
    .orderBy(desc(calendarEntries.expiresAt));

  return NextResponse.json({ intents });
}

/**
 * POST /calendar/api/availability — set an availability intent (the standing note).
 *
 * Sealed by default: setting an intent surfaces NOTHING. It sits until the match
 * engine (#1102) finds a bilateral overlap or the TTL expires.
 *
 * Body:
 *   intent         string  required  — the switch, e.g. "going_out"
 *   activityTags   string[]          — activity overlap surface, e.g. ["film","eat"]
 *   sensitiveTags  string[]          — subset of activityTags flagged sensitive (double-blind only)
 *   reach          string            — 'favourites' | 'one_degree' | 'strangers' (default: 'favourites')
 *   window         string            — shorthand: 'today' | 'tonight' | 'this_weekend' | 'this_week' | 'next_week'
 *   startsAt       ISO string        — explicit (overrides window)
 *   endsAt         ISO string        — explicit (overrides window)
 *   expiresAt      ISO string        — explicit TTL (overrides window)
 *   title          string            — optional display title
 */
export async function POST(request: Request) {
  // App-auth path: service token (broker-agent acting on behalf of a user)
  const appAuthResult = await requireAppAuth(request, { scope: 'availability:write' });
  if ('appAuth' in appAuthResult) {
    const actingFor = request.headers.get('x-acting-for');
    if (!actingFor) {
      return NextResponse.json({ error: 'X-Acting-For header required for app auth' }, { status: 400 });
    }
    return handleAvailabilityPost(request, appAuthResult.appAuth.appDid, actingFor);
  }

  // Session auth path: cookie or session Bearer token
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  return handleAvailabilityPost(request, auth.identity.id, resolveActingDid(auth.identity));
}

async function handleAvailabilityPost(request: Request, issuerId: string, did: string) {

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const intent = typeof body.intent === 'string' ? body.intent.trim() : null;
  if (!intent) {
    return NextResponse.json({ error: 'intent is required' }, { status: 400 });
  }

  const reach: Reach = REACH_VALUES.includes(body.reach as Reach)
    ? (body.reach as Reach)
    : 'favourites';

  const activityTags: string[] = Array.isArray(body.activityTags)
    ? (body.activityTags as string[]).filter((t) => typeof t === 'string')
    : [];

  const sensitiveTags: string[] = Array.isArray(body.sensitiveTags)
    ? (body.sensitiveTags as string[]).filter((t) => typeof t === 'string' && activityTags.includes(t))
    : [];

  // Resolve time window from shorthand or explicit timestamps.
  let startsAt: Date | null = null;
  let endsAt: Date | null = null;
  let expiresAt: Date | null = null;

  if (typeof body.window === 'string') {
    try {
      const resolved = resolveWindow(body.window);
      startsAt = resolved.startsAt;
      endsAt = resolved.endsAt;
      expiresAt = resolved.expiresAt;
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
  }

  // Explicit timestamps override window.
  if (body.startsAt) startsAt = new Date(body.startsAt as string);
  if (body.endsAt) endsAt = new Date(body.endsAt as string);
  if (body.expiresAt) expiresAt = new Date(body.expiresAt as string);

  const id = generateId('avail');

  const [entry] = await db
    .insert(calendarEntries)
    .values({
      id,
      did,
      type: 'availability',
      title: typeof body.title === 'string' ? body.title : null,
      intent,
      activityTags: activityTags.length > 0 ? activityTags : null,
      sensitiveTags: sensitiveTags.length > 0 ? sensitiveTags : null,
      reach,
      startsAt,
      endsAt,
      expiresAt,
      visibility: 'sealed',    // always sealed on create — nothing surfaces until a match fires
      metadata: (body.metadata as Record<string, unknown>) ?? {},
    })
    .returning();

  // Fire and forget — two events:
  // 1. calendar.entry.created: generic entry lifecycle event.
  // 2. availability.intent.created: match-engine trigger (fires the bilateral match pipeline).
  publishCalendarEntry('calendar.entry.created', issuerId, did, entry.id, entry.type, log);

  publish('availability.intent.created', {
    issuer: issuerId,
    subject: did,
    scope: 'calendar',
    payload: {
      intentId: entry.id,
      did,
      reach,
      activityTags: entry.activityTags ?? [],
      sensitiveTags: entry.sensitiveTags ?? [],
      context_id: entry.id,
      context_type: 'calendar',
    },
  }).catch((err: unknown) => log.error({ err: String(err) }, 'availability.intent.created emit error'));

  return NextResponse.json({ intent: entry }, { status: 201 });
}
