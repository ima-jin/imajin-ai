import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { requireAuth } from '@imajin/auth';
import { db, bumpSessions, bumpEvents, bumpMatches, connections } from '@/src/db';
import { and, eq, ne, gt, gte, lte, or, isNull, desc } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import {
  correlateBump,
  haversineDistance,
  BUMP_CORRELATION_THRESHOLD,
  BUMP_MATCH_WINDOW_MS,
  BUMP_LOCATION_RADIUS_M,
} from '@/src/lib/registry/bump-correlation';
import { notifyBumpDid } from '@/src/lib/registry/bump-notify';
import { profiles } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /registry/api/bump/event
 * Submit an accelerometer/gyro sample for correlation.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  let body: {
    sessionId?: string;
    waveform?: number[];
    rotationRate?: number[];
    timestamp?: number;
    location?: { lat: number; lng: number };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { sessionId, waveform, rotationRate, timestamp, location } = body;

  if (!sessionId || !Array.isArray(waveform) || !Array.isArray(rotationRate) || typeof timestamp !== 'number') {
    return NextResponse.json({ error: 'sessionId, waveform, rotationRate, and timestamp are required' }, { status: 400, headers: cors });
  }

  const did = authResult.identity.actingAs || authResult.identity.id;
  const now = new Date();

  try {
    // Validate session belongs to caller and is active
    const [session] = await db
      .select()
      .from(bumpSessions)
      .where(and(eq(bumpSessions.id, sessionId), eq(bumpSessions.did, did)))
      .limit(1);

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404, headers: cors });
    }
    if (session.deactivatedAt || session.expiresAt < now) {
      return NextResponse.json({ error: 'Session is no longer active' }, { status: 410, headers: cors });
    }

    // Rate limit: max 1 event per second per session
    const [lastEvent] = await db
      .select()
      .from(bumpEvents)
      .where(eq(bumpEvents.sessionId, sessionId))
      .orderBy(desc(bumpEvents.createdAt))
      .limit(1);

    if (lastEvent?.createdAt && now.getTime() - lastEvent.createdAt.getTime() < 1000) {
      return NextResponse.json({ error: 'Rate limit: 1 event per second per session' }, { status: 429, headers: cors });
    }

    // Store the event
    const eventId = generateId('bevt');
    const eventTime = new Date(timestamp);
    await db.insert(bumpEvents).values({
      id: eventId,
      sessionId,
      waveform,
      rotationRate,
      timestamp: eventTime,
      location: location ?? null,
    });

    // Find other active sessions on the same node
    const otherSessions = await db
      .select()
      .from(bumpSessions)
      .where(and(
        eq(bumpSessions.nodeId, session.nodeId),
        ne(bumpSessions.id, sessionId),
        isNull(bumpSessions.deactivatedAt),
        gt(bumpSessions.expiresAt, now),
      ));

    // Time window for matching
    const minTime = new Date(eventTime.getTime() - BUMP_MATCH_WINDOW_MS);
    const maxTime = new Date(eventTime.getTime() + BUMP_MATCH_WINDOW_MS);

    // Collect candidates: any session with an event in the time window + location range
    let bestCandidate: { other: typeof otherSessions[0]; otherEvent: typeof bumpEvents.$inferSelect; score: number } | null = null;

    for (const other of otherSessions) {
      const [otherEvent] = await db
        .select()
        .from(bumpEvents)
        .where(and(
          eq(bumpEvents.sessionId, other.id),
          gte(bumpEvents.timestamp, minTime),
          lte(bumpEvents.timestamp, maxTime),
        ))
        .orderBy(desc(bumpEvents.createdAt))
        .limit(1);

      if (!otherEvent) {
        log.info({ otherSessionId: other.id, minTime: minTime.toISOString(), maxTime: maxTime.toISOString() }, '[bump/event] candidate has no event in window');
        continue;
      }

      // Check location proximity (skip if either side has no location)
      if (location && otherEvent.location) {
        const otherLoc = otherEvent.location as { lat: number; lng: number };
        const dist = haversineDistance(location.lat, location.lng, otherLoc.lat, otherLoc.lng);
        if (dist > BUMP_LOCATION_RADIUS_M) continue;
      }

      // Waveform correlation for ranking — NOT a gate.
      // Temporal + spatial coincidence is sufficient for v1.
      // Both users must confirm, which is the human filter.
      const score = correlateBump(
        waveform,
        rotationRate,
        otherEvent.waveform as number[],
        otherEvent.rotationRate as number[],
      );

      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = { other, otherEvent, score };
      }
    }

    // No candidate found
    if (!bestCandidate) {
      log.info({
        sessionId,
        nodeId: session.nodeId,
        otherActiveSessions: otherSessions.length,
        eventTime: eventTime.toISOString(),
        hasLocation: !!location,
      }, '[bump/event] no match — no candidate found');
      return NextResponse.json({
        matched: false,
        debug: {
          otherActiveSessions: otherSessions.length,
          windowMs: BUMP_MATCH_WINDOW_MS,
          nodeId: session.nodeId,
        },
      }, { headers: cors });
    }

    const { other, score } = bestCandidate;

    // Check if already connected
    const [sortedA, sortedB] = [did, other.did].sort((a, b) => a.localeCompare(b));
    const [existingConn] = await db
      .select()
      .from(connections)
      .where(and(
        eq(connections.didA, sortedA),
        eq(connections.didB, sortedB),
        isNull(connections.disconnectedAt),
      ))
      .limit(1);

    if (existingConn) {
      const [callerProfile] = await db.select().from(profiles).where(eq(profiles.did, did)).limit(1);
      const [otherProfile] = await db.select().from(profiles).where(eq(profiles.did, other.did)).limit(1);
      const connectedAt = existingConn.connectedAt.toISOString();

      notifyBumpDid(did, {
        type: 'bump:already_connected' as any,
        peer: { did: other.did, handle: otherProfile?.handle ?? undefined, name: otherProfile?.displayName ?? undefined, avatar: otherProfile?.avatar ?? undefined },
        connectedAt,
      }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/event] notify already_connected error'));

      notifyBumpDid(other.did, {
        type: 'bump:already_connected' as any,
        peer: { did, handle: callerProfile?.handle ?? undefined, name: callerProfile?.displayName ?? undefined, avatar: callerProfile?.avatar ?? undefined },
        connectedAt,
      }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/event] notify already_connected error'));

      return NextResponse.json({ matched: true, alreadyConnected: true, connectedAt }, { headers: cors });
    }

    // Create match
    const matchId = generateId('bmatch');
    const matchExpiry = new Date(Date.now() + 60 * 1000);

    await db.insert(bumpMatches).values({
      id: matchId,
      nodeId: session.nodeId,
      sessionA: sessionId,
      sessionB: other.id,
      correlationScore: score,
      expiresAt: matchExpiry,
    });

    publish('bump.match', {
      issuer: did,
      subject: did,
      scope: 'registry',
      payload: { matchId, otherDid: other.did, nodeId: session.nodeId },
    }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/event] publish bump.match error'));

    // Notify both parties via WebSocket
    const expiresAtISO = matchExpiry.toISOString();
    const [callerProfile] = await db.select().from(profiles).where(eq(profiles.did, did)).limit(1);
    const [otherProfile] = await db.select().from(profiles).where(eq(profiles.did, other.did)).limit(1);

    notifyBumpDid(other.did, {
      type: 'bump:matched',
      matchId,
      peer: { did, handle: callerProfile?.handle ?? undefined, name: callerProfile?.displayName ?? undefined },
      expiresAt: expiresAtISO,
    }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/event] notify other error'));

    notifyBumpDid(did, {
      type: 'bump:matched',
      matchId,
      peer: { did: other.did, handle: otherProfile?.handle ?? undefined, name: otherProfile?.displayName ?? undefined },
      expiresAt: expiresAtISO,
    }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/event] notify caller error'));

    return NextResponse.json({ matched: true, matchId }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, '[bump/event] error');
    return NextResponse.json({ error: 'Failed to process event' }, { status: 500, headers: cors });
  }
}
