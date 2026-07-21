/**
 * POST /pay/api/topup/emt
 *
 * Create a pending EMT top-up transaction.
 * Admin will match the incoming EMT and credit the balance.
 * Auth required.
 *
 * Request: { amount: number }
 * Response: { success: boolean, transactionId: string, instructions: { email, amount, memo } }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { db, transactions } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';

const MIN_TOPUP = 20; // $20 CAD minimum

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  // Auth
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status || 401, headers: cors }
    );
  }

  const did = resolveActingDid(authResult.identity);
  const handle = authResult.identity.handle || '';

  let body: { amount?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { amount } = body;

  if (!amount || typeof amount !== 'number' || amount < MIN_TOPUP) {
    return NextResponse.json(
      { error: `Minimum top-up is $${MIN_TOPUP}` },
      { status: 400, headers: cors }
    );
  }

  // Create pending transaction — no balance change yet
  const txId = generateId('tx');
  await db.insert(transactions).values({
    id: txId,
    service: 'emt',
    type: 'topup',
    fromDid: null,
    toDid: did,
    amount: amount.toString(),
    currency: 'CAD',
    status: 'pending',
    source: 'fiat',
    metadata: {
      method: 'emt',
      handle,
      email: 'pay@imajin.ai',
      memo: handle ? `@${handle}` : did.slice(-12),
    },
  });

  log.info({ service: 'pay', did, amount, transactionId: txId }, 'EMT top-up pending created');

  return NextResponse.json(
    {
      success: true,
      transactionId: txId,
      instructions: {
        email: 'pay@imajin.ai',
        amount,
        memo: handle ? `@${handle}` : did.slice(-12),
      },
    },
    { headers: cors }
  );
});
