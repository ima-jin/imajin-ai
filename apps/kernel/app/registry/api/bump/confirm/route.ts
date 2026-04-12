import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { requireAuth, emitAttestation } from '@imajin/auth';
import { db, bumpSessions, bumpMatches, pods, podMembers, connections, profiles, nodes } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { notifyBumpDid } from '@/src/lib/registry/bump-notify';
import { createLogger } from '@imajin/logger';
import { createEmitter } from '@imajin/events';

const log = createLogger('kernel');
const eventBus = createEmitter('registry');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
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

  const callerDid = authResult.identity.actingAs || authResult.identity.id;

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
      await db.update(bumpMatches)
        .set({ confirmedA: false, confirmedB: false })
        .where(eq(bumpMatches.id, matchId));

      // Notify both parties
      const otherDid = isPartyA ? sessionB.did : sessionA.did;
      notifyBumpDid(otherDid, { type: 'bump:match_expired', matchId, reason: 'declined' })
        .catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] notify decline error'));
      notifyBumpDid(callerDid, { type: 'bump:match_expired', matchId, reason: 'declined' })
        .catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] notify decline error'));

      return NextResponse.json({ status: 'declined' }, { headers: cors });
    }

    // Accept: set the caller's confirmation flag
    const updateData = isPartyA ? { confirmedA: true } : { confirmedB: true };
    const [updated] = await db.update(bumpMatches)
      .set(updateData)
      .where(eq(bumpMatches.id, matchId))
      .returning();

    const otherDid = isPartyA ? sessionB.did : sessionA.did;

    // Both confirmed — create the connection
    if (updated.confirmedA && updated.confirmedB) {
      try {
        const didA = sessionA.did;
        const didB = sessionB.did;
        const podId = generateId('pod');

        // Look up profiles for labels + node for provenance
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
        // Insert or reconnect (clear disconnected_at if previously disconnected)
        // Check if this was a reconnect to prevent sybil attestation farming
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
          .where(eq(bumpMatches.id, matchId));

        eventBus.emit({ action: 'bump.confirm', did: callerDid, payload: { matchId, didA: sessionA.did, didB: sessionB.did } });
        if (!isReconnect) {
          eventBus.emit({ action: 'connection.create', did: didA, payload: { otherDid: didB, source: 'bump' } });
        }

        // Only emit attestations for NEW connections — prevents sybil farming via disconnect/reconnect
        if (!isReconnect) {
          emitAttestation({
            issuer_did: didA,
            subject_did: didB,
            type: 'connection.accepted',
            context_id: podId,
            context_type: 'connection',
            payload: { source: 'bump', match_id: matchId, node_id: match.nodeId, node_name: nodeName },
          }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] attestation (connection.accepted) error'));

          emitAttestation({
            issuer_did: didB,
            subject_did: didA,
            type: 'vouch',
            context_id: podId,
            context_type: 'connection',
            payload: { source: 'bump', match_id: matchId, node_id: match.nodeId, node_name: nodeName },
          }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] attestation (vouch) error'));
        }

        // Notify both parties of the connection (profiles already fetched above)
        notifyBumpDid(didA, {
          type: 'bump:connected', matchId, connectionId: podId,
          peer: { did: didB, handle: profileB?.handle ?? undefined },
        }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] notify connected error'));

        notifyBumpDid(didB, {
          type: 'bump:connected', matchId, connectionId: podId,
          peer: { did: didA, handle: profileA?.handle ?? undefined },
        }).catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] notify connected error'));

        return NextResponse.json({ status: 'connected' }, { headers: cors });
      } catch (err) {
        log.error({ err: String(err) }, '[bump/confirm] connection creation failed');
        return NextResponse.json({ error: 'Failed to create connection' }, { status: 500, headers: cors });
      }
    }

    // One side accepted — tell the other they're waiting
    notifyBumpDid(otherDid, { type: 'bump:peer_confirmed', matchId })
      .catch((err: unknown) => log.error({ err: String(err) }, '[bump/confirm] notify peer_confirmed error'));

    return NextResponse.json({ status: 'waiting' }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, '[bump/confirm] error');
    return NextResponse.json({ error: 'Failed to confirm match' }, { status: 500, headers: cors });
  }
}
