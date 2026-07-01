import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions, withCors } from '@/src/lib/kernel/cors';
import { resolveEffectiveDid } from '@imajin/auth';
import { listConnections } from '@/src/lib/connections/list';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const auth = await resolveEffectiveDid(request, { scope: 'connections:read' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }

  const resolved = await listConnections(auth.effectiveDid);
  return withCors(NextResponse.json({ connections: resolved }), request);
}
