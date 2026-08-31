/**
 * POST /api/attestations/internal
 *
 * Service-to-service endpoint for issuing attestations server-side.
 * Signs the attestation using the platform keypair (AUTH_PRIVATE_KEY).
 * Authenticated via Bearer token (ATTESTATION_INTERNAL_API_KEY).
 *
 * Body: { issuer_did, subject_did, type, context_id?, context_type?, payload?, issued_at?, expires_at?, nostr_sig?, pending?, originUrl? }
 * No session cookie required — service-to-service only.
 *
 * For type `imajin/nostr-key-binding`: nostr_sig and issued_at are required.
 * The caller must compute nostr_sig client-side over the canonical payload
 * (including the provided issued_at) before calling this endpoint.
 *
 * `pending` (#1820): true only when the caller is creating a bilateral,
 * counterparty-signable attestation (e.g. the supply receipt flow) — threaded
 * into `attestation.created` as `pendingSignature`. Defaults to false so the
 * ~15 one-shot system attestation types created via this route (identity,
 * vouch, ticket receipts, etc.) never trigger a counterparty notification.
 *
 * `originUrl` (#1820): this route is called server-to-server, so it never
 * carries a browser `Origin` header. Callers that know the originating app's
 * URL (for the pending-signature notification's deep link) pass it explicitly
 * here; the request's `Origin` header (via `deriveOriginUrl`) is only a
 * fallback for the rare case a browser calls this route directly.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, attestations } from '@/src/db';
import { eq } from 'drizzle-orm';
import { canonicalize, crypto as authCrypto, ATTESTATION_TYPES } from '@imajin/auth';
import type { AttestationType } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { randomUUID } from 'node:crypto';
import { resolveIssuedAt, validateNostrKeyBinding, deriveOriginUrl, resolveEnvelopeFields, verifyDelegatedAttestation } from '../attestation-helpers';
import { isRegisteredAttestationType } from '@/src/lib/auth/attestation-type-registry';

const log = createLogger('kernel');

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

type EnvelopeResolution = ReturnType<typeof resolveEnvelopeFields>;

/**
 * Resolve + validate the intro-funnel envelope fields carried in `payload`,
 * including that `prev_event_ref` (when present) resolves to an existing
 * attestation. Extracted from POST so the handler's own branching stays
 * under the cognitive-complexity budget (#1885).
 */
async function resolveEnvelope(payload: unknown): Promise<EnvelopeResolution> {
  const envelopeResult = resolveEnvelopeFields(payload);
  if (!envelopeResult.ok) return envelopeResult;

  const { prevEventRef } = envelopeResult.envelope;
  if (!prevEventRef) return envelopeResult;

  const [predecessor] = await db.select({ id: attestations.id }).from(attestations).where(eq(attestations.id, prevEventRef)).limit(1);
  if (!predecessor) {
    return { ok: false, error: `prev_event_ref "${prevEventRef}" does not reference an existing attestation` };
  }
  return envelopeResult;
}

function resolveExpiresAt(value: unknown): Date | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

type NostrResolution = { ok: true; nostrSig: string | null } | { ok: false; error: string };

/**
 * For `imajin/nostr-key-binding` only: require + verify the caller-supplied
 * nostr_sig. A no-op for every other type. Extracted from POST to keep the
 * handler's own branching under the cognitive-complexity budget.
 */
function resolveNostrSignature(
  type: string,
  nostrSig: unknown,
  payload: unknown,
  canonicalPayload: string,
): NostrResolution {
  if (type !== 'imajin/nostr-key-binding') return { ok: true, nostrSig: null };
  const nostrResult = validateNostrKeyBinding(nostrSig, payload, canonicalPayload);
  return nostrResult.ok ? { ok: true, nostrSig: nostrResult.nostrSigToStore } : { ok: false, error: nostrResult.error };
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
  const pendingSignature = body.pending === true;
  const originUrl = (typeof body.originUrl === 'string' ? body.originUrl : undefined) ?? deriveOriginUrl(request);

  if (!issuer_did || typeof issuer_did !== 'string') {
    return NextResponse.json({ error: 'issuer_did required' }, { status: 400 });
  }
  if (!subject_did || typeof subject_did !== 'string') {
    return NextResponse.json({ error: 'subject_did required' }, { status: 400 });
  }
  if (!type || typeof type !== 'string') {
    return NextResponse.json({ error: 'type required' }, { status: 400 });
  }

  const isKnownType = (ATTESTATION_TYPES as readonly string[]).includes(type) || (await isRegisteredAttestationType(type));
  if (!isKnownType) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${ATTESTATION_TYPES.join(', ')}, or a type registered via /auth/api/attestations/types` },
      { status: 400 }
    );
  }

  // Intro-funnel envelope fields (#1885) ride inside `payload` — see resolveEnvelope.
  const envelopeResult = await resolveEnvelope(payload);
  if (!envelopeResult.ok) {
    return NextResponse.json({ error: envelopeResult.error }, { status: 400 });
  }
  const { delegatorDid, disclosureScope, prevEventRef } = envelopeResult.envelope;

  // Delegated attestations (#1895, #1897): a self-asserted delegator_did is
  // not proof of delegation — verify a live grant actually backs it before
  // minting a "delegated" fact into the honest record.
  const delegationCheck = await verifyDelegatedAttestation({
    delegatorDid,
    issuerDid: issuer_did,
    subjectDid: subject_did,
    type,
  });
  if (!delegationCheck.ok) {
    return NextResponse.json({ error: delegationCheck.error }, { status: 403 });
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
  const nostrResolution = resolveNostrSignature(type, body.nostr_sig, payload, canonicalPayload);
  if (!nostrResolution.ok) {
    return NextResponse.json({ error: nostrResolution.error }, { status: 400 });
  }
  const nostrSigToStore = nostrResolution.nostrSig;

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
        delegatorDid,
        disclosureScope,
        prevEventRef,
        delegationGrantId: delegationCheck.grantId,
        issuedAt: new Date(issuedAtMs),
        expiresAt,
      })
      .returning();

    // This route never accepts author_jws, so callers must opt into
    // `pendingSignature` explicitly via `pending` — it defaults to false so
    // the many one-shot system attestations created here never trigger a
    // counterparty notification (#1820).
    publish('attestation.created', {
      issuer: issuer_did,
      subject: subject_did,
      scope: 'auth',
      payload: {
        attestationId: attestation.id,
        type,
        issuerDid: issuer_did,
        subjectDid: subject_did,
        contextId: (context_id as string | undefined) ?? null,
        contextType: (context_type as string | undefined) ?? null,
        originUrl,
        pendingSignature,
      },
    }).catch((err: unknown) => log.error({ err: String(err) }, 'attestation.created publish failed'));

    return NextResponse.json(attestation, { status: 201 });
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to insert attestation');
    return NextResponse.json({ error: 'Failed to store attestation' }, { status: 500 });
  }
}
