/**
 * POST /api/identity/:did/sign
 *
 * Signs a canonical payload on behalf of a chain-verified identity using
 * AUTH_PRIVATE_KEY (the node's platform key).
 *
 * This is the "node attestation" model: the node signs as a witness that the
 * authenticated, chain-verified sender produced this content.
 *
 * Supports either:
 * - Internal Bearer auth via INTERNAL_API_KEY, or
 * - An authenticated browser session where session DID matches :did.
 * Only signs if the identity has a valid DFOS chain.
 *
 * Body: { payload: string }
 * Response: { signature: string } | { signed: false, reason: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { crypto as authCrypto } from '@imajin/auth';
import { getChainByImajinDid } from '@/src/lib/auth/dfos';
import { verifyChain } from '@imajin/dfos';
import { createLogger } from '@imajin/logger';
import { requireDocumentActor } from '@/src/lib/auth/document-authorization';
import { parseDocumentSigningPayload } from '@/src/lib/auth/document-signing-payload';

const log = createLogger('kernel');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;
  const decodedDid = decodeURIComponent(did);

  // Service-to-service auth (legacy/internal)
  const apiKey = request.headers.get('authorization')?.replaceAll('Bearer ', '');
  const expectedKey = process.env.INTERNAL_API_KEY;
  const isInternalRequest = !!expectedKey && apiKey === expectedKey;
  let chainDid = decodedDid;

  // Session auth (browser/client flow)
  if (!isInternalRequest) {
    const actor = await requireDocumentActor(request, { write: true });
    if (actor instanceof Response) return actor;
    if (actor.effectiveDid !== decodedDid) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // Org approval is witnessed by the node, backed by the human's chain.
    // This is not a signature made with an organization-held private key.
    chainDid = actor.actingHumanDid;
  }

  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  let body: { payload?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body?.payload || typeof body.payload !== 'string') {
    return NextResponse.json({ error: 'payload required (string)' }, { status: 400 });
  }

  if (!isInternalRequest) {
    const parsedPayload = parseDocumentSigningPayload(body.payload);
    if (parsedPayload?.did !== decodedDid) {
      return NextResponse.json({ error: 'payload must include matching did and document_hash' }, { status: 400 });
    }
  }

  // Only sign for chain-verified identities
  const chain = await getChainByImajinDid(chainDid);
  if (!chain) {
    return NextResponse.json({ signed: false, reason: 'no_chain' }, { status: 200 });
  }

  const verified = await verifyChain(chain.log as string[]);
  if (verified.isDeleted || verified.authKeys.length === 0) {
    return NextResponse.json({ signed: false, reason: 'chain_invalid' }, { status: 200 });
  }

  try {
    const signature = authCrypto.signSync(body.payload, privateKey);
    return NextResponse.json({ signature, signatureModel: 'node-witness' }, { status: 200 });
  } catch (err) {
    log.error({ err: String(err) }, '[sign] Signing failed');
    return NextResponse.json({ error: 'Signing failed' }, { status: 500 });
  }
}
