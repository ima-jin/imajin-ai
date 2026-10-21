/** Operator-only step activity status from the signed registry, never the harness. */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { gateOperator } from '@/src/lib/jin/spend-route-gate';
import { getLastStepEventAt } from '@/src/lib/loops/query';

const log = createLogger('kernel');
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  try {
    const gate = await gateOperator(request, cors, { lastStepEventAt: null });
    if ('response' in gate) return gate.response;

    const lastStepEventAt = await getLastStepEventAt(gate.operatorDid);
    return NextResponse.json({ isOperator: true, lastStepEventAt }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, 'jin horizon status read failed');
    return NextResponse.json({ error: 'Horizon status unavailable' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
