import express, { type Response, type Router } from 'express';
import { LocalAdapter } from './adapters/local';
import { CorpusEngine } from './engine';
import type { CorpusSearchRequest, ThreadDocument } from './engine/types';
import { isWorkspaceSource, resolveWorkspacePath, validateSourcePath, workspaceRootForDid, type WorkspaceOptions } from './lib/workspace';
// Service DID + ingestion-attestation signing (#2021 checklist) is not built
// yet; only claim verification lands here. See middleware/access-claim.ts.
import { createAccessClaimMiddleware } from './middleware/access-claim';

export type CorpusRouterOptions = WorkspaceOptions;

export function createCorpusRouter(engine: CorpusEngine, options: CorpusRouterOptions = {}): Router {
  const router = express.Router();

  // Single choke point for every /corpus/:did/* route (#1751). /health (and
  // the /spec route landing in a parallel PR) stay outside this prefix.
  router.use('/corpus/:did', createAccessClaimMiddleware());

  router.post('/corpus/:did/ingest', (request, response) => {
    handle(response, () => {
      const body: unknown = request.body;

      if (isSourceRequest(body)) {
        return crawlWorkspaceSource(engine, request.params.did, body.source, options);
      }

      if (!Array.isArray(body)) {
        throw new Error('body must be a ThreadDocument[] or { source }');
      }

      return engine.ingest(request.params.did, body as ThreadDocument[]);
    });
  });

  router.post('/corpus/:did/search', (request, response) => {
    handle(response, () => engine.search(request.params.did, request.body as CorpusSearchRequest));
  });

  router.post('/corpus/:did/sync', (request, response) => {
    const body = request.body as { source?: string; cursor?: string | null };
    if (!body?.source || !isWorkspaceSource(body.source)) {
      response.status(501).json({ error: 'sync is not implemented in v1' });
      return;
    }

    handle(response, () => syncWorkspaceSource(engine, request.params.did, body.source as string, body.cursor ?? null, options));
  });

  router.post('/corpus/:did/crawl', (request, response) => {
    handle(response, () => {
      const body = request.body as { source?: string };
      if (!body?.source) {
        throw new Error('source is required');
      }

      return crawlWorkspaceSource(engine, request.params.did, body.source, options);
    });
  });

  router.get('/corpus/:did/status', (request, response) => {
    handle(response, () => engine.status(request.params.did));
  });

  router.delete('/corpus/:did/source', (request, response) => {
    handle(response, () => {
      const body = request.body as { source?: string };
      return engine.deleteSource(request.params.did, body.source ?? '');
    });
  });

  router.get('/health', (_request, response) => {
    response.json({ ok: true, service: 'corpus' });
  });

  return router;
}

export function createCorpusApp(engine = new CorpusEngine(), options: CorpusRouterOptions = {}): express.Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(createCorpusRouter(engine, options));
  return app;
}

function isSourceRequest(body: unknown): body is { source: string } {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof (body as { source?: unknown }).source === 'string'
  );
}

/**
 * Resolves+validates a "local:workspace" source for `did`, returning the
 * absolute filesystem path the `LocalAdapter` should read from. The
 * resolved path is a runtime detail: callers must rewrite any
 * `ThreadDocument.source` produced from it back to the original
 * `local:workspace...` string before persisting or returning it.
 */
function resolveLocalWorkspaceSource(did: string, source: string, options: WorkspaceOptions): string {
  if (!isWorkspaceSource(source)) {
    throw new Error(`Unsupported source "${source}". Only "local:workspace" sources are supported.`);
  }

  const resolvedPath = resolveWorkspacePath(did, source, options);
  validateSourcePath(resolvedPath, workspaceRootForDid(did, options));
  return resolvedPath;
}

function rewriteSource(documents: ThreadDocument[], originalSource: string): ThreadDocument[] {
  return documents.map(document => ({ ...document, source: originalSource }));
}

async function collectDocuments(iterable: AsyncIterable<ThreadDocument>): Promise<ThreadDocument[]> {
  const documents: ThreadDocument[] = [];
  for await (const document of iterable) {
    documents.push(document);
  }
  return documents;
}

async function crawlWorkspaceSource(
  engine: CorpusEngine,
  did: string,
  source: string,
  options: WorkspaceOptions,
): Promise<{ ingested: number }> {
  const resolvedPath = resolveLocalWorkspaceSource(did, source, options);
  const adapter = new LocalAdapter();
  const documents = rewriteSource(await collectDocuments(adapter.fetch(`local:${resolvedPath}`)), source);

  return engine.ingest(did, documents);
}

async function syncWorkspaceSource(
  engine: CorpusEngine,
  did: string,
  source: string,
  cursor: string | null,
  options: WorkspaceOptions,
): Promise<{ ingested: number; cursor: string | null; hasMore: boolean }> {
  const resolvedPath = resolveLocalWorkspaceSource(did, source, options);
  const adapter = new LocalAdapter();
  const result = await adapter.sync(`local:${resolvedPath}`, cursor);
  const documents = rewriteSource(result.documents, source);
  engine.ingest(did, documents);

  return { ingested: documents.length, cursor: result.cursor, hasMore: result.hasMore };
}

async function handle<T>(response: Response, fn: () => T | Promise<T>): Promise<void> {
  try {
    response.json(await fn());
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'request failed' });
  }
}
