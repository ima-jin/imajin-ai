import { NextResponse, type NextRequest } from 'next/server';
import { publishSupplyStage } from '@/src/lib/supply';
import { corsHeaders } from '@/src/lib/kernel/cors';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export function POST(request: NextRequest) {
  return publishSupplyStage(request, 'supply.collected');
}
