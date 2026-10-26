import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { isBriefStorage } from '@/src/lib/warp/brief';
import { readBriefStorage, writeBriefStorage } from '@/src/lib/warp/brief-ledger';

export const dynamic = 'force-dynamic';

async function actor(request: NextRequest) {
  const auth = await requireAuth(request, { service: 'warp', sessionOnly: true });
  if ('error' in auth) return { error: auth.error, status: auth.status };
  const identity = auth.identity;
  if (identity.actingFor || identity.subtype === 'agent'
    || (identity.actingAs && identity.actingAsRole !== 'owner' && identity.actingAsRole !== 'admin')) {
    return { error: 'Principal owner authority required', status: 403 };
  }
  return { did: identity.actingAs ?? identity.id, human: identity.id };
}

export async function GET(request: NextRequest) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const auth = await actor(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  try {
    return NextResponse.json({ storage: await readBriefStorage(auth.did) }, { headers });
  } catch {
    return NextResponse.json({ error: 'Brief settings unavailable' }, { status: 503, headers });
  }
}

export async function PUT(request: NextRequest) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const auth = await actor(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'storage') || !isBriefStorage(body.storage)) {
    return NextResponse.json({ error: 'storage must be full-text or hash-only' }, { status: 400, headers });
  }
  try {
    return NextResponse.json(await writeBriefStorage(auth.did, auth.human, body.storage), { headers });
  } catch {
    return NextResponse.json({ error: 'Brief setting was not saved' }, { status: 503, headers });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
