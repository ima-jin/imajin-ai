import { NextResponse, type NextRequest } from 'next/server';
import { handleLotGet } from '@/src/lib/supply';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

// #1803 item 3: wrapped in withLogger so every read (success or denial) also
// gets the standard structured request log, on top of the DID-attributed
// audit record handleLotGet writes itself.
export const GET = withLogger('kernel', async (request: NextRequest) => {
  const correlationId = decodeURIComponent(request.url.split('/lot/')[1]?.split(/[?#]/)[0] ?? '');
  if (!correlationId) {
    return NextResponse.json({ error: 'Missing correlationId' }, { status: 400, headers: corsHeaders(request) });
  }
  return handleLotGet(request, correlationId);
});
