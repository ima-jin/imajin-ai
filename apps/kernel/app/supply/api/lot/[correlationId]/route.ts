import { NextResponse, type NextRequest } from 'next/server';
import { handleLotGet } from '@/src/lib/supply';
import { corsHeaders } from '@/src/lib/kernel/cors';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ correlationId: string }> }
) {
  const params = await props.params;
  return handleLotGet(request, params.correlationId);
}
