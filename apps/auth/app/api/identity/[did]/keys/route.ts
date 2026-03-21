import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, identities, identityChains, tokens } from '@/src/db';
import { eq } from 'drizzle-orm';
import { verifyChain } from '@imajin/dfos';
import { requireAuth } from '@/lib/middleware';
import { getChainByImajinDid } from '@/lib/dfos';
import type { KeyRoles } from '@/src/db/schema';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/identity/:did/keys
 * Authenticated — returns current key state for the authenticated identity.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    // Require auth — you can only see your own keys
    const session = await requireAuth(request);
    if (!session || session.sub !== decodedDid) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: cors }
      );
    }

    const chain = await getChainByImajinDid(decodedDid);
    if (!chain) {
      // No chain — return single-key state
      return NextResponse.json({
        did: decodedDid,
        singleKey: true,
        keyCount: 1,
        roles: null,
        message: 'Single keypair in all roles (default)',
      }, { headers: cors });
    }

    const verified = await verifyChain(chain.log as string[]);

    return NextResponse.json({
      did: decodedDid,
      dfosDid: chain.dfosDid,
      singleKey: false,
      chainLength: (chain.log as string[]).length,
      authKeys: verified.authKeys,
      assertKeys: verified.assertKeys,
      controllerKeys: verified.controllerKeys,
      lastRotated: chain.updatedAt,
    }, { headers: cors });
  } catch (err) {
    console.error('[keys] Error:', err);
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500, headers: cors }
    );
  }
}

/**
 * POST /api/identity/:did/keys
 *
 * Add or remove a key from a specific role via signed chain update.
 * The client builds the full updated chain log (signed with a controller key)
 * and sends it here. This is the server-side half of "Add this device."
 *
 * Request body: { log: string[], operationCID: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    // Require authenticated session
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
        { error: 'No DFOS chain found — cannot modify keys without a chain' },
        { status: 404, headers: cors }
      );
    }

    const body = await request.json();
    const { log, operationCID } = body as { log: string[]; operationCID: string };

    if (!Array.isArray(log) || log.length < 2 || !operationCID) {
      return NextResponse.json(
        { error: 'Invalid request: need log array (≥2 entries) and operationCID' },
        { status: 400, headers: cors }
      );
    }

    // Verify existing entries haven't been tampered with
    const existingLog = existingChain.log as string[];
    for (let i = 0; i < existingLog.length; i++) {
      if (log[i] !== existingLog[i]) {
        return NextResponse.json(
          { error: 'Chain tampering: existing log entries do not match' },
          { status: 400, headers: cors }
        );
      }
    }

    // Verify the full updated chain
    let verified;
    try {
      verified = await verifyChain(log);
    } catch (err: unknown) {
      return NextResponse.json(
        { error: `Chain verification failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400, headers: cors }
      );
    }

    if (verified.isDeleted) {
      return NextResponse.json(
        { error: 'Chain marks identity as deleted' },
        { status: 400, headers: cors }
      );
    }

    if (verified.controllerKeys.length === 0) {
      return NextResponse.json(
        { error: 'Must retain at least one controller key' },
        { status: 400, headers: cors }
      );
    }

    // Build key_roles from verified chain state
    const keyRoles: KeyRoles = {
      auth: verified.authKeys.map(k => k.publicKeyMultibase),
      assert: verified.assertKeys.map(k => k.publicKeyMultibase),
      controller: verified.controllerKeys.map(k => k.publicKeyMultibase),
    };

    // Update chain + identity
    await db.update(identityChains)
      .set({
        log,
        headCid: operationCID,
        keyCount: verified.authKeys.length + verified.assertKeys.length + verified.controllerKeys.length,
        updatedAt: new Date(),
      })
      .where(eq(identityChains.did, decodedDid));

    await db.update(identities)
      .set({
        keyRoles,
        updatedAt: new Date(),
      })
      .where(eq(identities.id, decodedDid));

    return NextResponse.json({
      did: decodedDid,
      dfosDid: existingChain.dfosDid,
      updated: true,
      authKeys: verified.authKeys.length,
      assertKeys: verified.assertKeys.length,
      controllerKeys: verified.controllerKeys.length,
    }, { headers: cors });
  } catch (err) {
    console.error('[keys] Error updating keys:', err);
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500, headers: cors }
    );
  }
}
