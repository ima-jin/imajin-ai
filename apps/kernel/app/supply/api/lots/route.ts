import { NextResponse, type NextRequest } from 'next/server';
import { handleLotsBySupplierGet } from '@/src/lib/supply';
import { corsHeaders } from '@/src/lib/kernel/cors';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export function GET(request: NextRequest) {
  return handleLotsBySupplierGet(request);
}
