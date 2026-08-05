/**
 * POST /api/attestations/internal
 *
 * Service-to-service endpoint for issuing attestations server-side.
 * Signs the attestation using the platform keypair (AUTH_PRIVATE_KEY).
 * Authenticated via Bearer token (ATTESTATION_INTERNAL_API_KEY).
 *
 * Body: { issuer_did, subject_did, type, context_id?, context_type?, payload?, issued_at?, expires_at?, nostr_sig? }
 * No session cookie required — service-to-service only.
 *
 * For type `imajin/nostr-key-binding`: nostr_sig and issued_at are required.
 * The caller must compute nostr_sig client-side over the canonical payload
 * (including the provided issued_at) before calling this endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, attestations } from '@/src/db';
import { canonicalize, crypto as authCrypto, ATTESTATION_TYPES } from '@imajin/auth';
import type { AttestationType } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { randomUUID } from 'node:crypto';
import { resolveIssuedAt, validateNostrKeyBinding } from '../attestation-helpers';

const log = createLogger('kernel');

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function resolveExpiresAt(value: unknown): Date | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

export async function POST(request: NextRequest) {
  // API key auth
  const authHeader = request.headers.get('authorization');
  const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const expectedKey = process.env.ATTESTATION_INTERNAL_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    log.error({}, 'AUTH_PRIVATE_KEY not set — cannot sign attestation');
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

  // Accept issued_at so the caller can pre-compute nostr_sig over the exact canonical form.
  const issuedAtMs = resolveIssuedAt(body.issued_at);
  const expiresAt = resolveExpiresAt(body.expires_at);
  if (expiresAt === undefined) {
    return NextResponse.json({ error: 'expires_at must be a valid ISO 8601 date' }, { status: 400 });
  }

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
    log.error({ err: String(err) }, 'Failed to sign attestation');
    return NextResponse.json({ error: 'Signing failed' }, { status: 500 });
  }

  // For imajin/nostr-key-binding: require + verify the caller-supplied nostr_sig.
  let nostrSigToStore: string | null = null;
  if (type === 'imajin/nostr-key-binding') {
    const nostrResult = validateNostrKeyBinding(body.nostr_sig, payload, canonicalPayload);
    if (!nostrResult.ok) {
      return NextResponse.json({ error: nostrResult.error }, { status: 400 });
    }
    nostrSigToStore = nostrResult.nostrSigToStore;
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
        nostrSig: nostrSigToStore,
        issuedAt: new Date(issuedAtMs),
        expiresAt,
      })
      .returning();

    return NextResponse.json(attestation, { status: 201 });
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to insert attestation');
    return NextResponse.json({ error: 'Failed to store attestation' }, { status: 500 });
  }
}
