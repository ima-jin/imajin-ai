/** GET /api/loops/spend?window=YYYY-MM — signed registry attribution in USD. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { readRegistrySpend } from '@/src/lib/loops/spend';
import { parseUsageWindow } from '@/src/lib/usage/window';

const log = createLogger('kernel:loops:spend');
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  const principal = resolveActingDid(auth.identity);
  const params = new URL(request.url).searchParams;
  if (params.has('principal') && params.get('principal') !== principal) {
    return NextResponse.json({ error: 'principal must match the authenticated caller' }, { status: 403, headers: cors });
  }
  const window = parseUsageWindow(params.get('window'));
  if (!window) return NextResponse.json({ error: 'window must be YYYY-MM or YYYY-MM-DD..YYYY-MM-DD' }, { status: 400, headers: cors });
  try {
    const spend = await readRegistrySpend(principal, window.from.toISOString(), window.to.toISOString());
    return NextResponse.json(spend, { headers: { ...cors, 'Cache-Control': 'no-store' } });
  } catch (err) {
    log.error({ err: String(err) }, 'loop registry spend read failed');
    return NextResponse.json({ error: 'Registry spend unavailable' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
