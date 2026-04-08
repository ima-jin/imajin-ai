import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  return NextResponse.json({ ok: true, service: 'notify' }, { headers: cors });
}
