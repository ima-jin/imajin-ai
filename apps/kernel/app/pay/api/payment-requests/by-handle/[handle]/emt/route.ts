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
 * #2656: a signed-in payer may send `{ "paidByDid": "did:…" }` — which of their
 * DIDs is paying (their own, or an org/business they control as owner/admin).
 * That is the one authenticated path on this route: 401 when unauthenticated,
 * 403 for a DID they can't act for (never stored). Without it the route stays
 * anonymous, exactly as before.
 *
 * 404 unknown/void handle · 409 already settled · 400 e-Transfer not on offer
 * for this request (the issuer has no receiving email set, or it isn't CAD).
 */
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP } from '@imajin/config';
import { requireAuth } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { isServiceError } from '@/src/lib/pay/payment-requests/service';
import { requestEmtPayInstructions, type EmtPayerChoice } from '@/src/lib/pay/payment-requests/emt';
import { payerPersonDidOf } from '@/src/lib/pay/payment-requests/payer-dids';
import { toEmtInstructionsView } from '@/src/lib/pay/payment-requests/emt-offer';

const log = createLogger('kernel');

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

type PayerChoiceResult = { choice?: EmtPayerChoice } | { response: NextResponse };

/**
 * The optional `{ paidByDid }` body (#2656). An absent/empty body is the
 * classic anonymous call. A body that names a DID needs a signed-in caller,
 * whose person DID the choice is later checked against.
 */
async function readPayerChoice(request: NextRequest, cors: Record<string, string>): Promise<PayerChoiceResult> {
  let paidByDid: unknown;
  try {
    const text = await request.text();
    if (text) paidByDid = (JSON.parse(text) as { paidByDid?: unknown } | null)?.paidByDid;
  } catch {
    return { response: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors }) };
  }
  if (paidByDid === undefined || paidByDid === null || paidByDid === '') return {};
  if (typeof paidByDid !== 'string') {
    return { response: NextResponse.json({ error: 'paidByDid must be a string' }, { status: 400, headers: cors }) };
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return { response: NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors }) };
  }
  return { choice: { paidByDid, personDid: payerPersonDidOf(authResult.identity) } };
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

  const payer = await readPayerChoice(request, cors);
  if ('response' in payer) return payer.response;

  try {
    const result = await requestEmtPayInstructions(handle, ...(payer.choice ? [payer.choice] : []));
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
