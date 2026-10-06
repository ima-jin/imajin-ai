/**
 * POST /pay/api/payment-requests/:id/settle — issuer-only (or someone acting
 * for the issuer business, via `resolveActingDid`).
 *
 *  - `{method: 'manual', note}` — status -> `settled_manual`.
 *  - `{method: 'emt'}` (#2665, "Mark paid (e-Transfer)") — `emt_pending` ->
 *    `paid`, with the same ledger settlement / `.fair` / attestation records
 *    as a card payment. Idempotent: a replay is a 200 no-op
 *    (`settled: false`); a request already settled another way is a 409.
 *
 * `stripe`/`mjnx` methods are handled via checkout (#2209) — not accepted here.
 * The issuer check is enforced in the service, never trusted to the client.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { isServiceError, settlePaymentRequestManual } from '@/src/lib/pay/payment-requests/service';
import { settlePaymentRequestEmt } from '@/src/lib/pay/payment-requests/emt';
import { enforceRoutePolicy } from "@imajin/auth/delegation-policy";

const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
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
  const delegationDenied = enforceRoutePolicy(authResult.identity, "pay.payment-request.settle", { resourceId: id, headers: cors });
  if (delegationDenied) return delegationDenied;

  let body: SettleRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  if (body.method !== 'manual' && body.method !== 'emt') {
    return NextResponse.json(
      { error: "method must be 'manual' or 'emt' — 'stripe'/'mjnx' settlement is handled via checkout (#2209)" },
      { status: 400, headers: cors },
    );
  }
  if (body.note !== undefined && typeof body.note !== 'string') {
    return NextResponse.json({ error: 'note must be a string' }, { status: 400, headers: cors });
  }

  try {
    const result =
      body.method === 'emt'
        ? await settlePaymentRequestEmt({ id, callerDid })
        : await settlePaymentRequestManual({ id, callerDid, note: body.note });
    if (isServiceError(result)) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    return NextResponse.json(result, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), paymentRequestId: id }, 'payment_request settle error');
    return NextResponse.json({ error: 'Failed to settle payment_request' }, { status: 500, headers: cors });
  }
}
