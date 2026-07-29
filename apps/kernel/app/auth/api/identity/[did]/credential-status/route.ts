import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { db } from '@/src/db';
import { relayRevocations } from '@/src/db/schemas/relay';
import { getChainByImajinDid } from '@/src/lib/auth/dfos';
import { verifyChainLog } from '@/src/lib/auth/chain-providers';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /auth/api/identity/:did/credential-status
 * Public endpoint — check revocation status for a DID or a specific credential.
 *
 * RFC-40 §5: Revocation is a chain event. Checking "is this DID/key/delegation
 * still valid right now?" is answered by reading the verified chain head.
 *
 * Query parameters:
 *   ?cid=<credentialCid>  — check if a specific credential CID has been revoked
 *                           by this DID as the issuer (optional)
 *
 * When no ?cid param:
 *   Checks whether the DID's own chain head marks the identity as deleted/revoked.
 *
 * When ?cid=<credentialCid>:
 *   Checks relay_revocations for an issuer=DID / credentialCid entry.
 *   This is the credential-level revocation index (RFC-40 §5 + relay_revocations).
 *
 * Freshness note (RFC-40 §5 caveat): the check re-verifies the chain log stored
 * in identity_chains (the hosted transport). If the chain has been revoked via
 * a new chain entry that has not yet propagated to this node, the result reflects
 * "valid as of the last known chain head." This is stated explicitly in the response.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const imajinDid = decodeURIComponent(did);
    const url = new URL(request.url);
    const credentialCid = url.searchParams.get('cid');

    // --- Credential-level revocation check ---
    if (credentialCid) {
      const [row] = await db
        .select({ credentialCid: relayRevocations.credentialCid, createdAt: relayRevocations.createdAt })
        .from(relayRevocations)
        .where(
          and(
            eq(relayRevocations.issuerDid, imajinDid),
            eq(relayRevocations.credentialCid, credentialCid)
          )
        )
        .limit(1);

      return NextResponse.json(
        {
          did: imajinDid,
          credentialCid,
          type: 'CredentialRevocationCheck',
          revoked: !!row,
          ...(row ? { revokedAt: row.createdAt?.toISOString() } : {}),
          freshness: 'live',
          checkedAt: new Date().toISOString(),
        },
        { headers: cors }
      );
    }

    // --- DID key-state revocation check (chain head) ---
    const chain = await getChainByImajinDid(imajinDid);
    if (!chain) {
      return NextResponse.json(
        {
          did: imajinDid,
          type: 'DidKeyStateCheck',
          status: 'no-chain',
          revoked: false,
          note: 'This DID has no associated chain — key state cannot be verified.',
          checkedAt: new Date().toISOString(),
        },
        { headers: cors }
      );
    }

    // Re-verify the chain to get live key state.
    const result = await verifyChainLog(chain.log as string[]);

    if (!result.valid) {
      return NextResponse.json(
        {
          did: imajinDid,
          type: 'DidKeyStateCheck',
          status: 'invalid',
          revoked: true,
          chainHead: chain.headCid,
          error: result.error ?? 'Chain verification failed',
          freshness: 'live',
          checkedAt: new Date().toISOString(),
        },
        { headers: cors }
      );
    }

    return NextResponse.json(
      {
        did: imajinDid,
        type: 'DidKeyStateCheck',
        status: result.isDeleted ? 'revoked' : 'valid',
        revoked: result.isDeleted ?? false,
        chainHead: chain.headCid,
        keyCount: result.keyCount ?? chain.keyCount,
        /**
         * Freshness model (RFC-40 §5): this result is derived from the chain log
         * stored on this node (transport #1). A revocation that propagated after
         * the last chain update to this node will not be reflected here.
         * For live revocation certainty, also check the DFOS relay transport.
         */
        freshness: 'cached-chain',
        checkedAt: new Date().toISOString(),
      },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, '[credential-status] Error');
    return NextResponse.json(
      { error: 'Failed to check credential status' },
      { status: 500, headers: cors }
    );
  }
}
