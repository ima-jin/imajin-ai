/**
 * GET /jin/api/spend/runs — INTERIM per-run cost and cost-per-closed-issue for
 * the /jin Spend lane (#2725). Operator-only; a non-operator gets
 * `{ isOperator: false, interim: null }`.
 *
 * Kept separate from `GET /jin/api/spend` because it fans out to Warp and
 * GitHub (slow, can fail independently) while the provider block is one DB
 * read. The derivation is a stopgap isolated in
 * `src/lib/jin/spend-interim-join.ts` — replaced by the #2290 loop registry.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { gateOperator } from '@/src/lib/jin/spend-route-gate';
import { readInterimSpend } from '@/src/lib/jin/spend-interim-join';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const gate = await gateOperator(request, cors, { interim: null });
  if ('response' in gate) return gate.response;

  try {
    const interim = await readInterimSpend(gate.operatorDid);
    return NextResponse.json({ isOperator: true, interim }, { headers: { ...cors, 'Cache-Control': 'no-store' } });
  } catch (err) {
    log.error({ err: String(err) }, 'jin interim spend read failed');
    return NextResponse.json({ error: 'Interim spend unavailable' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
