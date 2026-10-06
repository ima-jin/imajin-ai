import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { recordKeyRotation, verifyNodeKeyHistory } from '@/src/lib/auth/node-key-rotation';

const log = createLogger('kernel');

/** Reads live key + DB state per request; must never be statically prerendered. */
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/keys/rotation — machine check for the node key (#2081).
 *
 * Admin-only. Verifies every `key.rotated` attestation this node has issued
 * (both signatures on each, one linear chain), that the chain ends at the key
 * the kernel is signing with right now, and that the node identity row carries
 * that key. `?anchor=<hex public key>` additionally pins the chain's genesis.
 * Always answers 200 with `ok`; a failing check is data, not a transport error.
 * Never returns key material — only kids, public keys and verdicts.
 */
export async function GET(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const anchor = request.nextUrl.searchParams.get('anchor') ?? undefined;
  try {
    return NextResponse.json(await verifyNodeKeyHistory({ anchorPublicKey: anchor }));
  } catch (error) {
    log.error({ err: String(error) }, 'Node key history verification failed');
    return NextResponse.json({ error: 'Node key history verification failed' }, { status: 500 });
  }
}

/**
 * POST /api/admin/keys/rotation — record a node key rotation (#2081).
 *
 * Admin-only. Body is the PUBLIC dual-signed payload produced offline by
 * `scripts/key-rotation.mjs sign` — `{ oldKid, newKid, oldPublicKey,
 * newPublicKey, effectiveAt, oldKeySignature, newKeySignature }`. No private
 * key is ever sent. The kernel re-verifies both signatures, requires the new
 * key to be the one it is signing with, and refuses a rotation that forks or
 * reuses a key in the recorded history. On success it files the node-issued
 * `key.rotated` attestation and returns its id.
 *
 * Call it AFTER the env swap and restart: the attestation envelope is signed
 * by the node's current (new) key.
 */
export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const result = await recordKeyRotation(body);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(
      {
        attestationId: result.attestationId,
        oldKid: result.oldKid,
        newKid: result.newKid,
        effectiveAt: result.effectiveAt,
      },
      { status: 201 },
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Recording node key rotation failed');
    return NextResponse.json({ error: 'Recording node key rotation failed' }, { status: 500 });
  }
}
