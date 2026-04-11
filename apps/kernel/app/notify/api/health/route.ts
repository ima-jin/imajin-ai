import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  return NextResponse.json({
    ok: true,
    status: 'ok',
    service: 'notify',
    version: process.env.NEXT_PUBLIC_VERSION || '0.0.0',
    build: process.env.NEXT_PUBLIC_BUILD_HASH || 'dev',
  }, { headers: cors });
}
