import { NextRequest, NextResponse } from 'next/server';
import { db, connections } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { enforceDelegationPolicy, enforceRoutePolicy } from '@imajin/auth/delegation-policy';
import { blockForeignAgentStub } from '@/src/lib/auth/foreign-agent-stub';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import {
  isRelationshipLabel, RelationshipLabelError, relationshipLabelMutation, setRelationshipLabel,
} from '@/src/lib/connections/relationship-labels';
import { createLogger } from '@imajin/logger';

export const dynamic = 'force-dynamic';
const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/** PATCH changes only the selected business org's private side of an active connection. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> },
) {
  const headers = corsHeaders(request);
  const auth = await requireAuth(request, { service: 'connections' });
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }
  const { did } = await params;
  const denied = enforceDelegationPolicy(auth.identity, { ...relationshipLabelMutation, resourceId: did }, { headers });
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected an object' }, { status: 400, headers });
  }
  const { relationshipLabel, orgDid } = body as Record<string, unknown>;
  if (!isRelationshipLabel(relationshipLabel)
    || (orgDid !== undefined && (typeof orgDid !== 'string' || !orgDid.startsWith('did:') || !orgDid.trim()))) {
    return NextResponse.json({ error: 'Expected relationshipLabel: client, vendor, partner, other or null; optional orgDid must be a DID' }, { status: 400, headers });
  }
  try {
    const result = await setRelationshipLabel(
      (orgDid as string | undefined) ?? resolveActingDid(auth.identity), did, auth.identity, relationshipLabel,
    );
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof RelationshipLabelError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    log.error({ err: String(error) }, 'Relationship label update failed');
    return NextResponse.json({ error: 'Failed to update relationship label' }, { status: 500, headers });
  }
}

/**
 * DELETE /api/connections/:did - Disconnect from a connection
 * Sets disconnected_at on the connections row.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity } = authResult;
  const effectiveDid = resolveActingDid(identity);
  const { did: targetDid } = await params;
  const delegationDenied = enforceRoutePolicy(identity, 'kernel.connections.connection.delete', { resourceId: targetDid });
  if (delegationDenied) return delegationDenied;

  // Sort DIDs lexically to find the connection row
  const [didA, didB] = [effectiveDid, targetDid].sort((a, b) => a.localeCompare(b));

  const result = await db
    .update(connections)
    .set({ disconnectedAt: new Date() })
    .where(and(eq(connections.didA, didA), eq(connections.didB, didB)))
    .returning();

  // A stranger needs no connection to be blocked. Revoke synchronously, not
  // through an eventually-consistent reactor, before returning success.
  const blocked = await blockForeignAgentStub(targetDid, effectiveDid);
  if (result.length === 0 && !blocked) {
    return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
  }

  publish('connection.disconnect', { issuer: effectiveDid, subject: targetDid, scope: 'connections', payload: { otherDid: targetDid } }).catch(() => {});

  return NextResponse.json({ disconnected: true });
}
