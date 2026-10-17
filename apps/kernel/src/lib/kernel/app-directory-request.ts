import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';

/** Never accept a client-selected target instead of the authenticated effective identity. */
export async function authenticateAppDirectory(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return { error: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  }
  const did = resolveActingDid(auth.identity);
  const params = new URL(request.url).searchParams;
  if (['for', 'target', 'did', 'targetDid'].some((key) => params.has(key) && params.get(key) !== did)) {
    return { error: NextResponse.json({ error: 'Forbidden - self only' }, { status: 403 }) };
  }
  return { did, callerDid: auth.identity.id };
}
