import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { resolveScopeForAttestation, didInterestExists, createDidInterest } from './registry';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/interest
 *
 * Records an interest signal for a DID based on an attestation type.
 * Called internally whenever a user performs an action that maps to an interest scope.
 *
 * Body: { did: string, attestationType: string }
 * Auth: x-webhook-secret header
 *
 * Flow:
 *   1. Look up which scope the attestationType maps to in the registry interest catalog
 *   2. Check if did_interests row already exists — if so, no-op
 *   3. If not: POST to registry to create did_interests row
 *      (registry checks auto_subscribe preference to set channel defaults)
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const secret = request.headers.get('x-webhook-secret');
  if (!secret || secret !== process.env.NOTIFY_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  let body: { did: string; attestationType: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { did, attestationType } = body;
  if (!did || !attestationType) {
    return NextResponse.json(
      { error: 'Missing required fields: did, attestationType' },
      { status: 400, headers: cors },
    );
  }

  // Step 1: Resolve scope
  const scope = await resolveScopeForAttestation(attestationType, secret);
  if (!scope) {
    // Unknown attestation type — not an error, just nothing to record
    return NextResponse.json({ ok: true, action: 'no_scope' }, { headers: cors });
  }

  // Step 2: Check if already exists
  const exists = await didInterestExists(did, scope, secret);
  if (exists) {
    return NextResponse.json({ ok: true, action: 'already_exists' }, { headers: cors });
  }

  // Step 3: Create did_interests row via registry
  await createDidInterest(did, scope, attestationType, secret);

  return NextResponse.json({ ok: true, action: 'created', scope }, { headers: cors });
}
