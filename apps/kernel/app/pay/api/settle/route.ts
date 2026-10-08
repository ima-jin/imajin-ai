/**
 * POST /api/settle
 *
 * Settle a payment a registered app created at checkout (#2642). Authenticated
 * with the app's OWN app-service token carrying the operator-approved
 * `pay:settle` scope — no shared key. The kernel settles only a payment whose
 * `pay.transactions` row is bound to that app's DID, and verifies the posted
 * `fair_manifest` chain against the payee manifest recorded at checkout instead
 * of trusting the caller. See `src/lib/pay/app-settle.ts`.
 *
 * Request:
 * {
 *   transaction_id: string,        // the `transactionId` the app-authenticated checkout returned
 *   fair_manifest: {
 *     chain: Array<{ did: string, amount: number, role: string }>,
 *     taxCredits?: Array<{ did, amount, jurisdiction, kind, rateBps, remitTo, registrationNumber }>
 *   },
 *   total_amount?: number,         // optional; must equal the recorded payment when present
 *   from_did?: string,             // optional; must equal the recorded payer when present
 *   metadata?: Record<string, any>
 * }
 *
 * The payer, amount, currency, service, type and rail come from the kernel's
 * own payment record. A second settle of an already-settled payment is
 * idempotent: it returns the prior result (`alreadySettled: true`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { authenticateSettleApp, settleForApp } from '@/src/lib/pay/app-settle';

const log = createLogger('kernel');

// The settlement logic itself lives in `settlePayment()`
// (`apps/kernel/src/lib/pay/settle-core.ts`, #1073) and the registered-app
// contract in `app-settle.ts` — this route only owns HTTP concerns: auth
// dispatch, request parsing, and response mapping.

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    // Registered-app contract: app-service token + operator-approved pay:settle.
    // The retired shared PAY_SERVICE_API_KEY bearer is not a JWT and gets a 401.
    const auth = await authenticateSettleApp(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
    }

    const result = await settleForApp(auth.appDid, body);
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }

    return NextResponse.json(result, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Settlement error');
    return NextResponse.json(
      { error: 'Settlement failed' },
      { status: 500, headers: cors }
    );
  }
}
