/** Operator-only adapter over the signed loop registry; no harness/gateway reads. */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { gateOperator } from '@/src/lib/jin/spend-route-gate';
import { listLoopsPage } from '@/src/lib/loops/query';
import { orderRuns } from '@/src/lib/jin/runs-lane';

const log = createLogger('kernel');
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const gate = await gateOperator(request, cors, { page: null });
  if ('response' in gate) return gate.response;

  const params = new URL(request.url).searchParams;
  const since = params.get('since');
  const limit = params.has('limit') ? Number(params.get('limit')) : 50;
  if ((since && Number.isNaN(Date.parse(since))) || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    return NextResponse.json({ error: 'Invalid since or limit' }, { status: 400, headers: cors });
  }
  if (params.has('principal') && params.get('principal') !== gate.operatorDid) {
    return NextResponse.json({ error: 'principal must match the operator' }, { status: 403, headers: cors });
  }

  try {
    const page = await listLoopsPage({
      principal: gate.operatorDid,
      state: params.get('state'),
      kind: params.get('kind'),
      since,
      ancestor: params.get('ancestor'),
      cursor: params.get('cursor'),
      limit,
    });
    return NextResponse.json({ isOperator: true, page: { ...page, loops: orderRuns(page.loops) } }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, 'jin runs read failed');
    return NextResponse.json({ error: 'Runs unavailable' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
