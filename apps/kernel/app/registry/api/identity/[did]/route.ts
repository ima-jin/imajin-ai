import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { hexToMultibase } from '@imajin/auth';
import { corsHeaders } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { db, identities } from '@/src/db';
import { getChainByImajinDid } from '@/src/lib/auth/dfos';

const log = createLogger('kernel');

// CORS preflight — external verifiers must be able to call this.
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /registry/api/identity/:did — public did:imajin resolver (Issue #1443).
 *
 * Open endpoint, no auth required. Returns only public-safe data:
 *   - Claimed identity  → W3C DID Document + resolve.ts compat fields.
 *   - Soft/stub identity → { did, tier:'soft', verifiable:false, stub:true }
 *   - Unknown DID        → 404
 *
 * Intentionally omits: name, handle, email, metadata, controller/agent grants,
 * and any field not needed to verify a signature.
 *
 * This is the canonical transport for did:imajin resolution (RFC-40 §4, transport #1).
 * Trust comes from the chain, not this endpoint; the chain log is the source of truth.
 *
 * Also the path resolve.ts createHttpResolver now targets:
 *   GET {serviceUrl}/registry/api/identity/:did
 *
 * DFOS relay (GET {relay}/proof/v1/identities/:did, relay 0.13.5) is the
 * documented interim fallback for callers without HTTP access to this endpoint.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);

  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    if (!decodedDid.startsWith('did:imajin:')) {
      return NextResponse.json(
        { error: 'Invalid DID — must be a did:imajin DID' },
        { status: 400, headers: cors }
      );
    }

    const [identity] = await db
      .select({
        id: identities.id,
        publicKey: identities.publicKey,
        scope: identities.scope,
        subtype: identities.subtype,
        tier: identities.tier,
      })
      .from(identities)
      .where(eq(identities.id, decodedDid))
      .limit(1);

    if (!identity) {
      return NextResponse.json(
        { error: 'DID not found' },
        { status: 404, headers: cors }
      );
    }

    // Soft/stub identities hold a placeholder key (soft_<nanoid>), not a real
    // Ed25519 key. Return a defined non-leaking response so external verifiers
    // know the DID exists but cannot be used for signature verification yet.
    const isSoft = identity.tier === 'soft' || identity.publicKey.startsWith('soft_');
    if (isSoft) {
      return NextResponse.json(
        {
          did: identity.id,
          tier: identity.tier,
          subtype: identity.subtype ?? undefined,
          verifiable: false,
          stub: true,
        },
        { headers: cors }
      );
    }

    // Claimed identity — build the public DID Document.
    const keyId = `${identity.id}#key-1`;

    // Convert hex public key to W3C Multikey multibase (z6Mk...).
    // Fails closed: if the stored key is malformed, return 500.
    let publicKeyMultibase: string;
    try {
      publicKeyMultibase = hexToMultibase(identity.publicKey);
    } catch (err) {
      log.error({ err: String(err), did: decodedDid }, '[registry/identity] publicKey encoding failed');
      return NextResponse.json(
        { error: 'Failed to encode public key' },
        { status: 500, headers: cors }
      );
    }

    // Optional: DFOS chain metadata (hints — not trusted; verifier re-verifies).
    const chain = await getChainByImajinDid(decodedDid);

    const doc = {
      // W3C DID Document fields (RFC-40 §3.2)
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
      ],
      id: identity.id,
      verificationMethod: [
        {
          id: keyId,
          type: 'Ed25519VerificationKey2020',
          controller: identity.id,
          publicKeyMultibase,
        },
      ],
      authentication: [keyId],
      assertionMethod: [keyId],

      // Compatibility fields consumed by resolve.ts / @imajin/auth
      did: identity.id,
      publicKey: identity.publicKey,  // hex — used by FAIR verifyManifest
      type: identity.scope,            // 'actor' | 'business' | ...
      tier: identity.tier,
      ...(identity.subtype ? { subtype: identity.subtype } : {}),

      // DFOS chain hints (untrusted transport metadata — verifier must re-verify)
      ...(chain ? {
        dfosDid: chain.dfosDid,
        'imajin:chainHead': chain.headCid,
        'imajin:keyCount': chain.keyCount,
      } : {}),
    };

    return NextResponse.json(doc, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, '[registry/identity] resolve error');
    return NextResponse.json(
      { error: 'Failed to resolve DID' },
      { status: 500, headers: cors }
    );
  }
}
