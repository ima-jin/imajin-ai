import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, identities, identityChains, tokens } from '@/src/db';
import { eq } from 'drizzle-orm';
import { verifyChainLog } from '@/src/lib/auth/chain-providers';
import { requireAuth } from '@/src/lib/auth/middleware';
import type { KeyRoles } from '@/src/db';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/identity/:did/rotate
 *
 * Receives an already-signed chain update (client signs with controller key),
 * verifies it, stores the updated chain, and invalidates all existing sessions.
 *
 * Request body: { log: string[] } — the full updated chain log (existing + new update entry)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    // Require authenticated session for this DID
    const session = await requireAuth(request);
    if (!session || session.sub !== decodedDid) {
      return NextResponse.json(
        { error: 'Unauthorized — must be authenticated as this identity' },
        { status: 401, headers: cors }
      );
    }

    // Load existing chain
    const [existingChain] = await db
      .select()
      .from(identityChains)
      .where(eq(identityChains.did, decodedDid))
      .limit(1);

    if (!existingChain) {
      return NextResponse.json(
        { error: 'No DFOS chain found — cannot rotate without a chain' },
        { status: 404, headers: cors }
      );
    }

    // Rate limit: max 1 rotation per hour
    const lastUpdate = new Date(existingChain.updatedAt!);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (lastUpdate > hourAgo) {
      return NextResponse.json(
        { error: 'Key rotation rate limit: max 1 per hour' },
        { status: 429, headers: cors }
      );
    }

    // Parse request body
    const body = await request.json();
    const { log } = body as { log: string[] };

    if (!Array.isArray(log) || log.length < 2) {
      return NextResponse.json(
        { error: 'Invalid request: log must be an array with at least 2 entries (genesis + update)' },
        { status: 400, headers: cors }
      );
    }

    // Verify the existing entries haven't been tampered with
    const existingLog = existingChain.log as string[];
    for (let i = 0; i < existingLog.length; i++) {
      if (log[i] !== existingLog[i]) {
        return NextResponse.json(
          { error: 'Chain tampering: existing log entries do not match' },
          { status: 400, headers: cors }
        );
      }
    }

    // Verify the full updated chain via provider abstraction
    const result = await verifyChainLog(log);
    if (!result.valid) {
      return NextResponse.json(
        { error: `Chain verification failed: ${result.error}` },
        { status: 400, headers: cors }
      );
    }

    if (result.isDeleted) {
      return NextResponse.json(
        { error: 'Chain marks identity as deleted' },
        { status: 400, headers: cors }
      );
    }

    if (!result.keys || result.keys.controller.length === 0) {
      return NextResponse.json(
        { error: 'Update must retain at least one controller key' },
        { status: 400, headers: cors }
      );
    }

    // Build key_roles from verified chain state
    const keyRoles: KeyRoles = {
      auth: result.keys.auth.map(k => k.publicKeyMultibase),
      assert: result.keys.assert.map(k => k.publicKeyMultibase),
      controller: result.keys.controller.map(k => k.publicKeyMultibase),
    };

    // Get new head CID (from the last log entry — the update we just verified)
    const newHeadCid = body.operationCID as string;
    if (!newHeadCid) {
      return NextResponse.json(
        { error: 'Missing operationCID in request body' },
        { status: 400, headers: cors }
      );
    }

    const totalKeyCount = result.keys.auth.length + result.keys.assert.length + result.keys.controller.length;

    // Update the chain record
    await db.update(identityChains)
      .set({
        log,
        headCid: newHeadCid,
        keyCount: totalKeyCount,
        updatedAt: new Date(),
      })
      .where(eq(identityChains.did, decodedDid));

    // Update identity key_roles
    await db.update(identities)
      .set({
        keyRoles,
        updatedAt: new Date(),
      })
      .where(eq(identities.id, decodedDid));

    // Invalidate all existing tokens for this DID
    await db.delete(tokens)
      .where(eq(tokens.identityId, decodedDid));

    return NextResponse.json({
      did: decodedDid,
      dfosDid: existingChain.dfosDid,
      rotated: true,
      keyCount: totalKeyCount,
      sessionsInvalidated: true,
    }, { headers: cors });
  } catch (err) {
    console.error('[rotate] Error:', err);
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500, headers: cors }
    );
  }
}
