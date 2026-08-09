/**
 * POST /auth/corpus/api/load (#1731)
 *
 * Triggers ingestion for a new corpus source from the DID dashboard's "Load
 * new source" form. Resolves the acting DID from the session and proxies the
 * submitted `{ sourceType, source }` body to `POST /corpus/:did/ingest` on
 * the corpus service. This route is a thin proxy only — it does not fetch
 * documents from GitHub/local/etc. itself; that adapter-driven fetch-and-load
 * workflow lives in `apps/corpus/` (#1726/#1729/#1732), not the kernel.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { loadCorpusSource, CorpusServiceError } from '@/src/lib/kernel/corpus-client';

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const did = resolveActingDid(auth.identity);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const result = await loadCorpusSource(did, body);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof CorpusServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    log.error({ err: String(err), did }, 'Corpus source load failed');
    return NextResponse.json({ error: 'Failed to load corpus source' }, { status: 502 });
  }
}
