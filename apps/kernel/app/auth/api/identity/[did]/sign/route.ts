/**
 * POST /api/identity/:did/sign
 *
 * Internal service-to-service endpoint. Signs a canonical payload on behalf
 * of a chain-verified identity using AUTH_PRIVATE_KEY (the node's platform key).
 *
 * This is the "node attestation" model: the node signs as a witness that the
 * authenticated, chain-verified sender produced this content.
 *
 * Authenticated via Bearer token (INTERNAL_API_KEY).
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

const log = createLogger('kernel');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  // Service-to-service auth
  const apiKey = request.headers.get('authorization')?.replace('Bearer ', '');
  const expectedKey = process.env.INTERNAL_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  if (!body.payload || typeof body.payload !== 'string') {
    return NextResponse.json({ error: 'payload required (string)' }, { status: 400 });
  }

  const { did } = await params;
  const decodedDid = decodeURIComponent(did);

  // Only sign for chain-verified identities
  const chain = await getChainByImajinDid(decodedDid);
  if (!chain) {
    return NextResponse.json({ signed: false, reason: 'no_chain' }, { status: 200 });
  }

  const verified = await verifyChain(chain.log as string[]);
  if (verified.isDeleted || verified.authKeys.length === 0) {
    return NextResponse.json({ signed: false, reason: 'chain_invalid' }, { status: 200 });
  }

  try {
    const signature = authCrypto.signSync(body.payload, privateKey);
    return NextResponse.json({ signature }, { status: 200 });
  } catch (err) {
    log.error({ err: String(err) }, '[sign] Signing failed');
    return NextResponse.json({ error: 'Signing failed' }, { status: 500 });
  }
}
