/**
 * DELETE /auth/corpus/api/source (#1731)
 *
 * Removes a source (and its ingested threads) from the acting DID's corpus.
 * Resolves the acting DID from the session and proxies the request to
 * `DELETE /corpus/:did/source` on the corpus service.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { deleteCorpusSource, CorpusServiceError } from '@/src/lib/kernel/corpus-client';

const log = createLogger('kernel');

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const did = resolveActingDid(auth.identity);

  let body: { source?: unknown };
  try {
    body = (await request.json()) as { source?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.source !== 'string' || body.source.length === 0) {
    return NextResponse.json({ error: 'source is required' }, { status: 400 });
  }

  try {
    const result = await deleteCorpusSource(did, { source: body.source });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof CorpusServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    log.error({ err: String(err), did }, 'Corpus source removal failed');
    return NextResponse.json({ error: 'Failed to remove corpus source' }, { status: 502 });
  }
}
