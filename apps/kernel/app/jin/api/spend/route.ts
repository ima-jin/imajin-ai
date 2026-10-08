/**
 * GET /jin/api/spend — the /jin Spend lane's provider block (#2725): today's
 * cost per provider, current-period spend next to each provider's cap, and the
 * 7-day trend. Operator-only (same gate as `GET /jin/api/grants`); a
 * non-operator gets `{ isOperator: false, spend: null }`.
 *
 * Read-only over existing tables — see `src/lib/jin/spend-lane.ts`. Cost
 * figures are USD from `usage.incurred`, the same ledger `GET
 * /usage/api/summary` reads.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { gateOperator } from '@/src/lib/jin/spend-route-gate';
import { readSpendLane } from '@/src/lib/jin/spend-lane';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const gate = await gateOperator(request, cors, { spend: null });
  if ('response' in gate) return gate.response;

  try {
    const spend = await readSpendLane(gate.operatorDid);
    return NextResponse.json({ isOperator: true, spend }, { headers: { ...cors, 'Cache-Control': 'no-store' } });
  } catch (err) {
    log.error({ err: String(err) }, 'jin spend lane read failed');
    return NextResponse.json({ error: 'Spend unavailable' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
