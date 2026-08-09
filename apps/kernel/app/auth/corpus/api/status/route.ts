/**
 * GET /auth/corpus/api/status (#1731)
 *
 * Session-authenticated status read for the DID dashboard's Corpus tab.
 * Resolves the acting DID from the session (same `requireAuth` +
 * `resolveActingDid` pattern every other `/auth/*` route uses) and proxies to
 * `GET /corpus/:did/status` on the corpus service — sources, per-source
 * thread counts, and freshness.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { fetchCorpusStatus, CorpusServiceError } from '@/src/lib/kernel/corpus-client';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const did = resolveActingDid(auth.identity);

  try {
    const status = await fetchCorpusStatus(did);
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof CorpusServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    log.error({ err: String(err), did }, 'Corpus status query failed');
    return NextResponse.json({ error: 'Corpus status unavailable' }, { status: 502 });
  }
}
