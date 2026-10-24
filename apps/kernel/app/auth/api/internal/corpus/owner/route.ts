import { NextRequest, NextResponse } from 'next/server';
import { requireInternalApiKey } from '@/src/lib/auth/require-internal-api-key';
import { resolveCorpusDid } from '@/src/lib/kernel/corpus-owner';

export const dynamic = 'force-dynamic';

/** Identity-only lookup for the corpus daemon and its one-shot transfer. */
export async function POST(request: NextRequest) {
  const denied = await requireInternalApiKey(request);
  if (denied) return denied;
  let body: { source?: unknown; principalDid?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body?.source !== 'string' || typeof body.principalDid !== 'string' || !body.principalDid) {
    return NextResponse.json({ error: 'source and principalDid are required' }, { status: 400 });
  }
  try {
    return NextResponse.json({ did: await resolveCorpusDid(body.source, body.principalDid) });
  } catch {
    return NextResponse.json({ error: 'Corpus owner resolution unavailable' }, { status: 503 });
  }
}
