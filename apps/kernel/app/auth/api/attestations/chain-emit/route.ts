/**
 * POST /api/attestations/chain-emit
 *
 * Service-to-service endpoint. After the DB attestation write succeeds,
 * emitAttestation() calls this to write the same attestation as a DFOS
 * content chain genesis entry on the local relay.
 *
 * Non-fatal by design — a relay ingest failure is logged but never
 * propagated back to the caller. Authenticated via Bearer token
 * (ATTESTATION_INTERNAL_API_KEY, same key as /api/attestations/internal).
 *
 * Body: { issuer_did, subject_did, type, context_id?, context_type?, payload?, issued_at }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAttestationEntry } from '@/src/lib/auth/dfos';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  // API key auth — same key as /api/attestations/internal
  const authHeader = request.headers.get('authorization');
  const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const expectedKey = process.env.ATTESTATION_INTERNAL_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { issuer_did, subject_did, type, context_id, context_type, payload, issued_at } = body;

  if (
    typeof issuer_did !== 'string' ||
    typeof subject_did !== 'string' ||
    typeof type !== 'string'
  ) {
    return NextResponse.json({ error: 'issuer_did, subject_did, and type are required strings' }, { status: 400 });
  }

  const issuedAt = issued_at instanceof Date
    ? issued_at
    : typeof issued_at === 'string'
      ? new Date(issued_at)
      : new Date();

  const ok = await createAttestationEntry({
    issuer_did,
    subject_did,
    type,
    context_id: typeof context_id === 'string' ? context_id : null,
    context_type: typeof context_type === 'string' ? context_type : null,
    payload: payload != null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null,
    issued_at: issuedAt,
  });

  if (!ok) {
    log.warn({ type }, 'chain-emit: createAttestationEntry returned false');
  }

  // Always return 200 — chain emission is non-fatal
  return NextResponse.json({ ok }, { status: 200 });
}
