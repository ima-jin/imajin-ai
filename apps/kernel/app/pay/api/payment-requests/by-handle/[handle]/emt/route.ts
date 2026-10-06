/**
 * POST /pay/api/payment-requests/by-handle/:handle/emt — unauthenticated
 * (#2665). The payer chose "Pay by e-Transfer" on `/pay/r/:handle`: moves the
 * request `issued -> emt_pending` and returns the instructions
 * `{ email, amount, memo }` (the same shape as `POST /pay/api/topup/emt`),
 * plus `amountMinor` / `currency` so the page can print the exact amount.
 *
 * Keyed by the opaque `pay_handle` like the other pay-link routes — the link
 * is the capability, so there is no auth, only an IP rate limit. Idempotent:
 * calling it again returns the same instructions (`already_pending: true`).
 * Never blocks paying by card instead.
 *
 * 404 unknown/void handle · 409 already settled · 400 e-Transfer not on offer
 * for this request (the issuer has no receiving email set, or it isn't CAD).
 */
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP } from '@imajin/config';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { isServiceError } from '@/src/lib/pay/payment-requests/service';
import { requestEmtPayInstructions } from '@/src/lib/pay/payment-requests/emt';
import { toEmtInstructionsView } from '@/src/lib/pay/payment-requests/emt-offer';

const log = createLogger('kernel');

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
  const cors = corsHeaders(request);
  const { handle } = await params;

  const rl = rateLimit(getClientIP(request), RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } },
    );
  }

  try {
    const result = await requestEmtPayInstructions(handle);
    if (isServiceError(result)) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    const view = toEmtInstructionsView(result.instructions);
    return NextResponse.json(
      {
        success: true,
        already_pending: result.alreadyPending,
        instructions: {
          email: view.email,
          // Major units, as the top-up route returns it; `amountMinor` is the exact integer.
          amount: view.amountMinor / 100,
          amountMinor: view.amountMinor,
          currency: view.currency,
          memo: view.memo,
        },
      },
      { headers: cors },
    );
  } catch (error) {
    log.error({ err: String(error), handle }, 'payment_request e-Transfer request error');
    return NextResponse.json({ error: 'Failed to start e-Transfer payment' }, { status: 500, headers: cors });
  }
}
