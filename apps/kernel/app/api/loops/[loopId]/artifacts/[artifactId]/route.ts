import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { getLoopOutputArtifact } from '@/src/lib/loops/artifact-store';

export const dynamic = 'force-dynamic';

/** A hash is an identifier, never a bearer capability: both loop and principal are required. */
export async function GET(
  request: NextRequest,
  props: { params: Promise<{ loopId: string; artifactId: string }> },
) {
  const headers = new Headers(corsHeaders(request));
  headers.set('Cache-Control', 'private, no-store');
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }

  const { loopId, artifactId } = await props.params;
  if (!loopId?.trim() || !artifactId?.trim()) {
    return NextResponse.json({ error: 'loopId and artifactId are required' }, { status: 400, headers });
  }
  const artifact = await getLoopOutputArtifact(loopId, resolveActingDid(auth.identity), artifactId);
  if (!artifact) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers });
  }
  return NextResponse.json(artifact, { headers });
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
