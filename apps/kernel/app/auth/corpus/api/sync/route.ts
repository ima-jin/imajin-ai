/**
 * POST /auth/corpus/api/sync (#1731)
 *
 * Triggers an incremental refresh of a corpus source (or every source, when
 * no `source` is given) from the DID dashboard. Resolves the acting DID from
 * the session and proxies the request to `POST /corpus/:did/sync` on the
 * corpus service.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { syncCorpusSource, CorpusServiceError } from '@/src/lib/kernel/corpus-client';

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const did = resolveActingDid(auth.identity);

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // A body-less sync-everything request is valid; keep the empty default.
  }

  try {
    const result = await syncCorpusSource(did, body);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof CorpusServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    log.error({ err: String(err), did }, 'Corpus source sync failed');
    return NextResponse.json({ error: 'Failed to sync corpus source' }, { status: 502 });
  }
}
