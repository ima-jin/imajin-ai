/**
 * POST /api/settle
 *
 * Execute a .fair multi-party settlement.
 * Validates from_did has sufficient balance, then atomically:
 * - Debit from_did (credits first, then cash)
 * - Credit each recipient in the fair_manifest chain (cash — real value earned)
 * - Log all transactions
 *
 * Request:
 * {
 *   from_did: string,
 *   total_amount: number,
 *   service: string,
 *   type: string,
 *   funded?: boolean,              // true = externally funded (e.g. Stripe), skip balance check/debit
 *   funded_provider?: string,      // "stripe", "solana", etc. — logged for audit
 *   fair_manifest: {
 *     chain: Array<{ did: string, amount: number, role: string }>
 *   },
 *   metadata?: Record<string, any>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { settlePayment } from '@/src/lib/pay/settle-core';

const log = createLogger('kernel');

// The settlement logic itself lives in `settlePayment()`
// (`apps/kernel/src/lib/pay/settle-core.ts`, #1073) — this route only owns
// HTTP concerns: API-key auth, request parsing, and response mapping.

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    // Service-to-service auth via API key
    const apiKey = request.headers.get('authorization')?.replaceAll('Bearer ', '');
    const expectedKey = process.env.PAY_SERVICE_API_KEY;

    if (!expectedKey || apiKey !== expectedKey) {
      return NextResponse.json(
        { error: 'Unauthorized - invalid API key' },
        { status: 401, headers: cors }
      );
    }

    const body = await request.json();
    const { from_did, total_amount, service, type, fair_manifest, funded, funded_provider, metadata, currency } = body;

    if (!from_did || !total_amount || !service || !type || !fair_manifest) {
      return NextResponse.json(
        { error: 'Missing required fields: from_did, total_amount, service, type, fair_manifest' },
        { status: 400, headers: cors }
      );
    }

    const result = await settlePayment({ from_did, total_amount, service, type, fair_manifest, funded, funded_provider, metadata, currency });
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
