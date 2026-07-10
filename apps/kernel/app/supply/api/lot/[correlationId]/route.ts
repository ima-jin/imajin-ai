import { NextResponse, type NextRequest } from 'next/server';
import { handleLotGet } from '@/src/lib/supply';
import { corsHeaders } from '@/src/lib/kernel/cors';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export function GET(request: NextRequest, { params }: { params: { correlationId: string } }) {
  return handleLotGet(request, params.correlationId);
}
