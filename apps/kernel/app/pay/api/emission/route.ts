/**
 * POST /api/emission
 *
 * Credit MJN to a DID's balance and log the transaction.
 * Service-to-service endpoint — requires PAY_SERVICE_API_KEY.
 *
 * Request:
 * {
 *   to_did: string,
 *   amount: number,
 *   currency: 'MJN',
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
import { db, balances, transactions } from '@/src/db';
import { sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@/src/lib/kernel/rate-limit';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
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
  const apiKey = request.headers.get('authorization')?.replace('Bearer ', '');
  const expectedKey = process.env.PAY_SERVICE_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json(
      { error: 'Unauthorized - invalid API key' },
      { status: 401, headers: cors }
    );
  }

  try {
    const body = await request.json();
    const { to_did, amount, currency, reason, metadata = {} } = body;

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

    if (currency !== 'MJN') {
      return NextResponse.json(
        { error: 'currency must be MJN' },
        { status: 400, headers: cors }
      );
    }

    if (!reason || typeof reason !== 'string') {
      return NextResponse.json(
        { error: 'reason is required' },
        { status: 400, headers: cors }
      );
    }

    const txId = generateId('tx');

    // Upsert balance — increment credit_amount
    await db
      .insert(balances)
      .values({
        did: to_did,
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
      toDid: to_did,
      amount: String(amount),
      currency: 'MJN',
      status: 'completed',
      source: 'emission',
      metadata: {
        reason,
        ...metadata,
      },
    });

    log.info(
      { amount, toDid: to_did.slice(0, 20), reason, txId },
      '[emission] MJN credited'
    );

    return NextResponse.json(
      {
        id: txId,
        amount: String(amount),
        to_did: to_did,
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
