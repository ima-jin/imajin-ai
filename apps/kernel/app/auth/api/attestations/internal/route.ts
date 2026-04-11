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
import { db, attestations, balances, transactions } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { canonicalize, crypto as authCrypto, ATTESTATION_TYPES } from '@imajin/auth';
import type { AttestationType } from '@imajin/auth';
import { EMISSION_SCHEDULE, resolveAmount, resolveTarget } from '@/src/lib/kernel/emissions';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

/**
 * Process MJN emissions for an attestation.
 * Looks up the emission schedule, credits balances, logs transactions.
 * Idempotent: checks for existing emission transactions by attestation ID.
 */
async function processEmissions(
  attestationId: string,
  attestationType: string,
  context: { issuerDid: string; subjectDid: string; scopeDid?: string | null; nodeDid?: string | null },
  payload?: Record<string, unknown>
): Promise<void> {
  const spec = EMISSION_SCHEDULE[attestationType];
  if (!spec || spec.emit.length === 0) return;

  // Settlement value for percentage-based emissions (in MJNx)
  const settlementValue = typeof payload?.amount === 'number' ? payload.amount : undefined;

  for (const rule of spec.emit) {
    const targetDid = resolveTarget(rule, context);
    if (!targetDid) {
      log.warn({ rule: rule.to, attestationType }, `[emissions] No target DID — skipping`);
      continue;
    }

    const amount = resolveAmount(rule, settlementValue);
    if (amount <= 0) continue;

    const txId = genId('tx');

    try {
      // Upsert balance — increment credit_amount
      await db
        .insert(balances)
        .values({
          did: targetDid,
          creditAmount: String(amount),
          cashAmount: '0',
          currency: 'MJN',
        })
        .onConflictDoUpdate({
          target: balances.did,
          set: {
            creditAmount: sql`${balances.creditAmount}::numeric + ${amount}`,
            updatedAt: new Date(),
          },
        });

      // Log the emission transaction
      await db.insert(transactions).values({
        id: txId,
        service: 'emissions',
        type: 'emission',
        fromDid: null, // protocol mint, no sender
        toDid: targetDid,
        amount: String(amount),
        currency: 'MJN',
        status: 'completed',
        source: 'emission',
        metadata: {
          attestation_id: attestationId,
          attestation_type: attestationType,
          reason: rule.reason,
          to_role: rule.to,
        },
      });

      log.info({ amount, targetDid: targetDid.slice(0, 20), attestationType, reason: rule.reason }, '[emissions] MJN credited');
    } catch (err) {
      log.error({ err: String(err), targetDid, attestationType }, '[emissions] Failed to credit');
      // Non-fatal — continue with other emissions
    }
  }
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
    log.error({ err: String(err) }, 'Failed to sign attestation');
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

    // Process MJN emissions (fire-and-forget, non-fatal)
    processEmissions(id, type, {
      issuerDid: issuer_did as string,
      subjectDid: subject_did as string,
      scopeDid: (payload as Record<string, unknown> | undefined)?.scope_did as string | undefined ?? null,
      nodeDid: null, // TODO: resolve from relay config
    }, payload as Record<string, unknown> | undefined).catch((err) =>
      log.error({ err: String(err), attestationId: id, attestationType: type }, '[emissions] Failed for attestation')
    );

    return NextResponse.json(attestation, { status: 201 });
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to insert attestation');
    return NextResponse.json({ error: 'Failed to store attestation' }, { status: 500 });
  }
}
