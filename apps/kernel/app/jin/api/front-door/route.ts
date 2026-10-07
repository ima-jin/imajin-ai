/**
 * GET/PUT /jin/api/front-door — read and author the operator's agent-reach
 * gate (#2598). Powers the /jin Front door lane.
 *
 * Same operator-identity gate as `GET /jin/api/grants` (#2292): a
 * non-operator identity — including `@jin` itself acting for the operator —
 * gets `{ isOperator: false }` on GET and 403 on PUT, so the endpoint never
 * confirms a gate exists to a caller who isn't allowed to see it.
 *
 * Zero new backend primitives: see `src/lib/jin/front-door.ts` for what it
 * reads and writes (identities.metadata jsonb + the existing `agent.reach`
 * consent grant + the existing registered `broker.consent.*` events). No
 * tables, no migrations. A saved change is live on the next reach call.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';
import {
  frontDoorTopicOptions,
  readFrontDoorConfig,
  validateFrontDoorConfig,
  writeFrontDoorConfig,
  MIN_DAILY_CAP,
  MAX_DAILY_CAP,
} from '@/src/lib/jin/front-door';

export const dynamic = 'force-dynamic';

type OperatorResult =
  | { ok: true; operatorDid: string }
  | { ok: false; response: NextResponse };

async function requireOperator(request: NextRequest, cors: Record<string, string>, onDeny: () => NextResponse): Promise<OperatorResult> {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return { ok: false, response: NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors }) };
  }
  const operatorDid = await getOperatorDid();
  if (!operatorDid || !isOperatorIdentity(authResult.identity, operatorDid)) {
    return { ok: false, response: onDeny() };
  }
  return { ok: true, operatorDid };
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const operator = await requireOperator(request, cors, () =>
    NextResponse.json({ isOperator: false }, { headers: cors }),
  );
  if (!operator.ok) return operator.response;

  const config = await readFrontDoorConfig(operator.operatorDid);
  if (!config) {
    return NextResponse.json({ error: 'Operator identity not found' }, { status: 404, headers: cors });
  }
  return NextResponse.json(
    {
      isOperator: true,
      config,
      topicOptions: frontDoorTopicOptions(),
      limits: { minDailyCap: MIN_DAILY_CAP, maxDailyCap: MAX_DAILY_CAP },
    },
    { headers: cors },
  );
}

export async function PUT(request: NextRequest) {
  const cors = corsHeaders(request);
  const operator = await requireOperator(request, cors, () =>
    NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: cors }),
  );
  if (!operator.ok) return operator.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const parsed = validateFrontDoorConfig(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: cors });
  }

  const written = await writeFrontDoorConfig(operator.operatorDid, parsed.config);
  if (!written) {
    return NextResponse.json({ error: 'Operator identity not found' }, { status: 404, headers: cors });
  }
  return NextResponse.json({ isOperator: true, config: parsed.config }, { headers: cors });
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
