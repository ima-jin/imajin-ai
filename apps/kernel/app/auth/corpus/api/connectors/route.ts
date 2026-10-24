import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { listCorpusGitHubConnectors } from '@/src/lib/github/corpus-credential';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const connectors = await listCorpusGitHubConnectors(resolveActingDid(auth.identity));
    return NextResponse.json({ connectors }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'GitHub connectors unavailable' }, { status: 503 });
  }
}
