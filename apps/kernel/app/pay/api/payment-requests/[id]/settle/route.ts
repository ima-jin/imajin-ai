/**
 * POST /pay/api/payment-requests/:id/settle {method: 'manual', note} —
 * issuer-only. status -> `settled_manual`. `stripe`/`mjnx` methods are
 * reserved for #2209 (checkout <-> payment_request linkage) — only
 * `manual` is accepted here.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { isServiceError, settlePaymentRequestManual } from '@/src/lib/pay/payment-requests/service';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface SettleRequestBody {
  method?: unknown;
  note?: unknown;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cors = corsHeaders(request);
  const { id } = await params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const callerDid = resolveActingDid(authResult.identity);

  let body: SettleRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  if (body.method !== 'manual') {
    return NextResponse.json(
      { error: "method must be 'manual' — 'stripe'/'mjnx' settlement is handled via checkout (#2209)" },
      { status: 400, headers: cors },
    );
  }
  if (body.note !== undefined && typeof body.note !== 'string') {
    return NextResponse.json({ error: 'note must be a string' }, { status: 400, headers: cors });
  }

  try {
    const result = await settlePaymentRequestManual({ id, callerDid, note: body.note });
    if (isServiceError(result)) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    return NextResponse.json(result, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), paymentRequestId: id }, 'payment_request settle error');
    return NextResponse.json({ error: 'Failed to settle payment_request' }, { status: 500, headers: cors });
  }
}
