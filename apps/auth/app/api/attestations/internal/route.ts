/**
 * POST /api/attestations/internal
 *
 * Service-to-service endpoint for issuing attestations server-side.
 * Signs the attestation using the platform keypair (AUTH_PRIVATE_KEY).
 * Authenticated via Bearer token (ATTESTATION_INTERNAL_API_KEY).
 *
 * Body: { issuer_did, subject_did, type, context_id?, context_type?, payload? }
 * No session cookie required — service-to-service only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, attestations } from '@/src/db';
import { canonicalize, crypto as authCrypto, ATTESTATION_TYPES } from '@imajin/auth';
import type { AttestationType } from '@imajin/auth';

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

export async function POST(request: NextRequest) {
  // API key auth
  const apiKey = request.headers.get('authorization')?.replace('Bearer ', '');
  const expectedKey = process.env.ATTESTATION_INTERNAL_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    console.error('AUTH_PRIVATE_KEY not set — cannot sign attestation');
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { issuer_did, subject_did, type, context_id, context_type, payload } = body;

  if (!issuer_did || typeof issuer_did !== 'string') {
    return NextResponse.json({ error: 'issuer_did required' }, { status: 400 });
  }
  if (!subject_did || typeof subject_did !== 'string') {
    return NextResponse.json({ error: 'subject_did required' }, { status: 400 });
  }
  if (!type || typeof type !== 'string') {
    return NextResponse.json({ error: 'type required' }, { status: 400 });
  }

  if (!(ATTESTATION_TYPES as readonly string[]).includes(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${ATTESTATION_TYPES.join(', ')}` },
      { status: 400 }
    );
  }

  const issuedAtMs = Date.now();

  const canonicalPayload = canonicalize({
    subject_did,
    type,
    context_id: context_id ?? null,
    context_type: context_type ?? null,
    payload: payload ?? null,
    issued_at: issuedAtMs,
  });

  let signature: string;
  try {
    signature = authCrypto.signSync(canonicalPayload, privateKey);
  } catch (err) {
    console.error('Failed to sign attestation:', err);
    return NextResponse.json({ error: 'Signing failed' }, { status: 500 });
  }

  const id = genId('att');

  try {
    const [attestation] = await db
      .insert(attestations)
      .values({
        id,
        issuerDid: issuer_did,
        subjectDid: subject_did,
        type: type as AttestationType,
        contextId: (context_id as string | undefined) ?? null,
        contextType: (context_type as string | undefined) ?? null,
        payload: (payload as Record<string, unknown> | undefined) ?? null,
        signature,
        issuedAt: new Date(issuedAtMs),
      })
      .returning();

    return NextResponse.json(attestation, { status: 201 });
  } catch (err) {
    console.error('Failed to insert attestation:', err);
    return NextResponse.json({ error: 'Failed to store attestation' }, { status: 500 });
  }
}
