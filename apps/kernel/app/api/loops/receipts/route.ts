import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { readLoopRequest } from '@/src/lib/loops/read-request';
import { parseLoopReceiptRequest } from '@/src/lib/loops/receipt-types';
import { lookupLoopReceipt } from '@/src/lib/loops/receipts';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'private, no-store' };
  const body = await readLoopRequest(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status, headers: cors });
  const parsed = parseLoopReceiptRequest(body.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: cors });
  const result = await lookupLoopReceipt(parsed.value);
  if (result.status === 'error') {
    return NextResponse.json({ error: result.error }, { status: result.httpStatus, headers: cors });
  }
  return NextResponse.json(result, { status: result.status === 'accepted' ? 200 : 404, headers: cors });
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
