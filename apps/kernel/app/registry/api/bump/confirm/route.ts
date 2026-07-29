import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions, profilePath } from '@imajin/config';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { db, bumpSessions, bumpMatches, pods, podMembers, connections, profiles, nodes } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { notifyBumpDid } from '@/src/lib/registry/bump-notify';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * Decline a bump match and notify both parties.
 * Cognitive complexity: 1 (≤ 15)
 */
async function declineBumpMatch(params: {
  matchId: string;
  isPartyA: boolean;
  sessionA: { did: string };
  sessionB: { did: string };
  callerDid: string;
  cors: ReturnType<typeof corsHeaders>;
}): Promise<NextResponse> {
  const { matchId, isPartyA, sessionA, sessionB, callerDid, cors } = params;
  await db.update(bumpMatches)
    .set({ confirmedA: false, confirmedB: false })
    .where(eq(bumpMatches.id, matchId));
  const otherDid = isPartyA ? sessionB.did : sessionA.did;
  notifyBumpDid(otherDid, { type: 'bump:match_expired', matchId, reason: 'declined' })
    .catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] notify decline error'));
  notifyBumpDid(callerDid, { type: 'bump:match_expired', matchId, reason: 'declined' })
    .catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] notify decline error'));
  return NextResponse.json({ status: 'declined' }, { headers: cors });
}

/**
 * Create a connection when both bump parties have confirmed.
 * Returns the connected response, or null if one party has not yet confirmed.
 * Cognitive complexity: 6 (≤ 15)
 */
async function createBumpConnection(params: {
  updated: { confirmedA: boolean | null; confirmedB: boolean | null };
  sessionA: { did: string };
  sessionB: { did: string };
  match: { id: string; nodeId: string };
  callerDid: string;
  cors: ReturnType<typeof corsHeaders>;
}): Promise<NextResponse | null> {
  const { updated, sessionA, sessionB, match, callerDid, cors } = params;
  if (!updated.confirmedA || !updated.confirmedB) return null;
  try {
    const didA = sessionA.did;
    const didB = sessionB.did;
    const podId = generateId('pod');

    const [profileA] = await db.select().from(profiles).where(eq(profiles.did, didA)).limit(1);
    const [profileB] = await db.select().from(profiles).where(eq(profiles.did, didB)).limit(1);
    const [node] = await db.select().from(nodes).where(eq(nodes.id, match.nodeId)).limit(1);

    const labelA = profileA?.handle || profileA?.displayName || didA.slice(0, 16);
    const labelB = profileB?.handle || profileB?.displayName || didB.slice(0, 16);
    const nodeName = node?.hostname || match.nodeId;

    await db.insert(pods).values({
      id: podId,
      name: `${labelA} ↔ ${labelB}`,
      description: `Connected via bump at ${nodeName}`,
      ownerDid: didA,
      type: 'personal',
      visibility: 'private',
    });

    await db.insert(podMembers).values([
      { podId, did: didA, role: 'member', addedBy: didA },
      { podId, did: didB, role: 'member', addedBy: didB },
    ]);

    const [connDidA, connDidB] = [didA, didB].sort((a, b) => a.localeCompare(b));
    const [existingConn] = await db.select().from(connections)
      .where(and(eq(connections.didA, connDidA), eq(connections.didB, connDidB)))
      .limit(1);
    const isReconnect = !!existingConn;

    if (isReconnect) {
      await db.update(connections)
        .set({ disconnectedAt: null })
        .where(and(eq(connections.didA, connDidA), eq(connections.didB, connDidB)));
    } else {
      await db.insert(connections).values({ didA: connDidA, didB: connDidB });
    }

    await db.update(bumpMatches)
      .set({ connectionId: podId })
      .where(eq(bumpMatches.id, match.id));

    publish('bump.confirm', {
      issuer: callerDid,
      subject: callerDid,
      scope: 'registry',
      payload: { matchId: match.id, didA: sessionA.did, didB: sessionB.did },
    }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] publish bump.confirm error'));

    if (!isReconnect) {
      publish('connection.create', {
        issuer: didA,
        subject: didA,
        scope: 'registry',
        payload: { otherDid: didB, source: 'bump' },
      }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] publish connection.create error'));
      publish('connection.accepted', {
        issuer: didA,
        subject: didB,
        scope: 'registry',
        payload: { source: 'bump', match_id: match.id, node_id: match.nodeId, node_name: nodeName, context_id: podId, context_type: 'connection' },
      }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] publish connection.accepted error'));
      publish('vouch', {
        issuer: didB,
        subject: didA,
        scope: 'registry',
        payload: { source: 'bump', match_id: match.id, node_id: match.nodeId, node_name: nodeName, context_id: podId, context_type: 'connection' },
      }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] publish vouch error'));
    }

    const metaA = (profileA?.metadata ?? {}) as Record<string, unknown>;
    const metaB = (profileB?.metadata ?? {}) as Record<string, unknown>;

    notifyBumpDid(didA, {
      type: 'bump:connected', matchId: match.id, connectionId: podId,
      peer: { did: didB, handle: profileB?.handle ?? undefined, name: profileB?.displayName ?? undefined, avatar: profileB?.avatar ?? undefined },
      redirectUrl: (metaB.bumpRedirectUrl as string) || profilePath(profileB?.handle || didB),
    }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] notify connected error'));

    notifyBumpDid(didB, {
      type: 'bump:connected', matchId: match.id, connectionId: podId,
      peer: { did: didA, handle: profileA?.handle ?? undefined, name: profileA?.displayName ?? undefined, avatar: profileA?.avatar ?? undefined },
      redirectUrl: (metaA.bumpRedirectUrl as string) || profilePath(profileA?.handle || didA),
    }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] notify connected error'));

    return NextResponse.json({ status: 'connected' }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, '[bump/confirm] connection creation failed');
    return NextResponse.json({ error: 'Failed to create connection' }, { status: 500, headers: cors });
  }
}

/**
 * POST /registry/api/bump/confirm
 * Accept or decline a bump match. If both parties accept, create a connection.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  let body: { matchId?: string; accept?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { matchId, accept } = body;

  if (!matchId || typeof accept !== 'boolean') {
    return NextResponse.json({ error: 'matchId and accept are required' }, { status: 400, headers: cors });
  }

  const callerDid = resolveActingDid(authResult.identity);

  try {
    const [match] = await db.select().from(bumpMatches).where(eq(bumpMatches.id, matchId)).limit(1);
    if (!match) {
      return NextResponse.json({ error: 'Match not found' }, { status: 404, headers: cors });
    }
    if (match.expiresAt < new Date()) {
      return NextResponse.json({ error: 'Match has expired' }, { status: 410, headers: cors });
    }
    if (match.connectionId) {
      return NextResponse.json({ status: 'connected' }, { headers: cors });
    }

    // Resolve which party the caller is
    const [sessionA] = await db.select().from(bumpSessions).where(eq(bumpSessions.id, match.sessionA)).limit(1);
    const [sessionB] = await db.select().from(bumpSessions).where(eq(bumpSessions.id, match.sessionB)).limit(1);

    if (!sessionA || !sessionB) {
      return NextResponse.json({ error: 'Sessions not found' }, { status: 404, headers: cors });
    }

    const isPartyA = sessionA.did === callerDid;
    const isPartyB = sessionB.did === callerDid;

    if (!isPartyA && !isPartyB) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: cors });
    }

    // Decline: immediately end the match for both parties
    if (!accept) {
      return declineBumpMatch({ matchId, isPartyA, sessionA, sessionB, callerDid, cors });
    }

    // Accept: set the caller's confirmation flag
    const updateData = isPartyA ? { confirmedA: true } : { confirmedB: true };
    const [updated] = await db.update(bumpMatches)
      .set(updateData)
      .where(eq(bumpMatches.id, matchId))
      .returning();

    const otherDid = isPartyA ? sessionB.did : sessionA.did;

    // Both confirmed — create the connection
    const connResponse = await createBumpConnection({ updated, sessionA, sessionB, match, callerDid, cors });
    if (connResponse) return connResponse;

    // One side accepted — tell the other they're waiting
    notifyBumpDid(otherDid, { type: 'bump:peer_confirmed', matchId })
      .catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] notify peer_confirmed error'));

    return NextResponse.json({ status: 'waiting' }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, '[bump/confirm] error');
    return NextResponse.json({ error: 'Failed to confirm match' }, { status: 500, headers: cors });
  }
}
