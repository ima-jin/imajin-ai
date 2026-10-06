/**
 * POST /api/emission
 *
 * Credit MJNx (the emitted, in-platform, never-withdrawable unit — #2016)
 * to a DID's balance and log the transaction. An emission can never mint
 * MJN (the receipt-backed, withdrawable unit) — `unit` must be 'MJNx'.
 * Service-to-service endpoint — requires PAY_SERVICE_API_KEY.
 *
 * Request:
 * {
 *   to_did: string,
 *   amount: number,
 *   unit: 'MJNx',
 *   reason: string,
 *   metadata?: {
 *     attestation_id?: string,
 *     attestation_type?: string,
 *     to_role?: string,
 *     [key: string]: unknown
 *   }
 * }
 *
 * Response:
 * {
 *   id: string,
 *   amount: string,
 *   to_did: string,
 *   status: 'completed'
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, transactions } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { MJNX, creditUnit } from '@/src/lib/pay/ledger';

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  // Rate limit: 60 requests per minute per IP
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 60, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  // Service-to-service auth via API key
  const apiKey = request.headers.get('authorization')?.replaceAll('Bearer ', '');
  const expectedKey = process.env.PAY_SERVICE_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json(
      { error: 'Unauthorized - invalid API key' },
      { status: 401, headers: cors }
    );
  }

  try {
    const body = await request.json();
    const { to_did, amount, unit, reason, metadata = {} } = body;

    // Validate required fields
    if (!to_did || typeof to_did !== 'string') {
      return NextResponse.json(
        { error: 'to_did is required' },
        { status: 400, headers: cors }
      );
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400, headers: cors }
      );
    }

    // #2016: an emission can NEVER mint the withdrawable unit. This is a
    // hard rejection, not a conversion — MJNx is the only unit this route
    // is allowed to credit.
    if (unit !== MJNX) {
      return NextResponse.json(
        { error: `unit must be ${MJNX}` },
        { status: 400, headers: cors }
      );
    }

    if (!reason || typeof reason !== 'string') {
      return NextResponse.json(
        { error: 'reason is required' },
        { status: 400, headers: cors }
      );
    }

    // #2016: the attestation this emission was minted against, when the
    // caller (the bus's mjn reactor) supplied one. Lifted out of the
    // freeform metadata bag into a first-class column.
    const attestationId = stringOrNull(metadata.attestation_id);
    // #2017: provenance of the schedule that produced this emission (the
    // bus_chain_configs row id + version), and the caller's dedupe key.
    const emissionConfigId = stringOrNull(metadata.emission_config_id);
    const emissionConfigVersion = Number.isInteger(metadata.emission_config_version)
      ? (metadata.emission_config_version as number)
      : null;
    const idempotencyKey = stringOrNull(metadata.idempotency_key);

    const txId = generateId('tx');

    // #2017: claim the transaction row and credit the balance atomically.
    // The row goes first: with an `idempotency_key`, a retry of an emission
    // that already landed hits the partial UNIQUE index, inserts nothing, and
    // is credited zero times. A failed credit rolls the claim back, so a
    // retry can still succeed.
    const created = await db.transaction(async (tx) => {
      const claimed = await tx
        .insert(transactions)
        .values({
          id: txId,
          service: 'emissions',
          type: 'emission',
          fromDid: null, // protocol mint, no sender
          toDid: to_did,
          amount: String(amount),
          currency: 'MJNx',
          unit: MJNX,
          sourceKind: 'emission',
          attestationId,
          emissionConfigId,
          emissionConfigVersion,
          idempotencyKey,
          status: 'completed',
          source: 'emission',
          metadata: {
            reason,
            ...metadata,
          },
        })
        .onConflictDoNothing()
        .returning({ id: transactions.id });
      if (claimed.length === 0) return false;

      // Upsert the MJNx balance row.
      await creditUnit(tx, to_did, MJNX, amount, { currency: 'MJNx' });
      return true;
    });

    if (!created) {
      // Duplicate delivery of an emission that already landed: success, no second credit.
      const [existing] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.idempotencyKey, idempotencyKey as string))
        .limit(1);
      log.info({ idempotencyKey, txId: existing?.id }, '[emission] duplicate delivery ignored');
      return NextResponse.json(
        {
          id: existing?.id ?? null,
          amount: String(amount),
          to_did,
          status: 'completed',
          duplicate: true,
        },
        { status: 200, headers: cors }
      );
    }

    log.info(
      { amount, toDid: to_did.slice(0, 20), reason, txId },
      '[emission] MJNx credited'
    );

    return NextResponse.json(
      {
        id: txId,
        amount: String(amount),
        to_did,
        status: 'completed',
      },
      { status: 201, headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Emission error');
    return NextResponse.json(
      { error: 'Emission failed' },
      { status: 500, headers: cors }
    );
  }
});
