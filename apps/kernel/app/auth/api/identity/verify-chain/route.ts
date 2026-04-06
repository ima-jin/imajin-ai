import { NextRequest, NextResponse } from 'next/server';
import { verifyChainLog } from '@/src/lib/auth/chain-providers';
import { getIdentityByDfosDid } from '@/src/lib/auth/dfos';

/**
 * POST /api/identity/verify-chain
 * Internal endpoint — accepts a chain log, verifies it, returns identity info.
 * Used by registry (and future services) to verify chain-backed identity.
 *
 * This is the chain abstraction point. When a second chain provider is added,
 * this endpoint handles the routing. Callers don't know which chain protocol was used.
 *
 * Request:
 * { chainLog: string[] }
 *
 * Response:
 * {
 *   valid: boolean,
 *   did?: string,        // canonical DID (did:imajin alias if exists, else chain DID)
 *   chainDid?: string,   // chain-native DID (e.g. did:dfos:...)
 *   publicKey?: string,  // current public key (hex) from chain head
 *   keyCount?: number,
 *   error?: string
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { chainLog } = body as { chainLog: string[] };

    if (!chainLog || !Array.isArray(chainLog) || chainLog.length === 0) {
      return NextResponse.json(
        { valid: false, error: 'chainLog must be a non-empty array' },
        { status: 400 }
      );
    }

    const result = await verifyChainLog(chainLog);

    if (!result.valid) {
      return NextResponse.json({
        valid: false,
        error: result.error ?? 'Chain verification failed',
      });
    }

    const chainDid = result.did!;
    const publicKey = result.publicKeyHex;
    const keyCount = result.keyCount ?? chainLog.length;

    // Look up if a did:imajin alias exists for this chain DID
    const identity = await getIdentityByDfosDid(chainDid);
    const canonicalDid = identity ? identity.imajinDid : chainDid;

    return NextResponse.json({
      valid: true,
      did: canonicalDid,
      chainDid,
      publicKey,
      keyCount,
    });
  } catch (error) {
    console.error('[verify-chain] Error:', error);
    return NextResponse.json(
      { valid: false, error: 'Internal error' },
      { status: 500 }
    );
  }
}
