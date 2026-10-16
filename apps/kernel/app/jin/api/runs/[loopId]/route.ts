import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { gateOperator } from '@/src/lib/jin/spend-route-gate';
import { getLoopWithHistory } from '@/src/lib/loops/query';

const log = createLogger('kernel');
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, props: { params: Promise<{ loopId: string }> }) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const gate = await gateOperator(request, cors, { detail: null });
  if ('response' in gate) return gate.response;
  const { loopId } = await props.params;
  if (!loopId?.trim()) {
    return NextResponse.json({ error: 'loopId is required' }, { status: 400, headers: cors });
  }
  try {
    const detail = await getLoopWithHistory(loopId, gate.operatorDid);
    if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: cors });
    return NextResponse.json({ isOperator: true, detail }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, 'jin run history read failed');
    return NextResponse.json({ error: 'Run history unavailable' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
