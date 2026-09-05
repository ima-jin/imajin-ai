import express, { type Response, type Router } from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubAdapter, isGitHubSource } from './adapters/github';
import { LocalAdapter } from './adapters/local';
import { CorpusEngine } from './engine';
import type { CorpusSearchRequest, SourceType, ThreadDocument } from './engine/types';
import { isWorkspaceSource, resolveWorkspacePath, validateSourcePath, workspaceRootForDid, type WorkspaceOptions } from './lib/workspace';
// Service DID + ingestion-attestation signing (#2021 checklist) is not built
// yet; only claim verification lands here. See middleware/access-claim.ts.
import { createAccessClaimMiddleware } from './middleware/access-claim';

export type CorpusRouterOptions = WorkspaceOptions;

export function createCorpusRouter(engine: CorpusEngine, options: CorpusRouterOptions = {}): Router {
  const router = express.Router();

  // Single choke point for every /corpus/:did/* route (#1751). /health and
  // /spec (#2020) stay outside this prefix and remain public.
  router.use('/corpus/:did', createAccessClaimMiddleware());

  router.post('/corpus/:did/ingest', (request, response) => {
    handle(response, () => {
      const body: unknown = request.body;

      if (isSourceRequest(body)) {
        return crawlSource(engine, request.params.did, body.source, options);
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

  router.post('/corpus/:did/sources', (request, response) => {
    handle(response, () => registerSource(engine, request.params.did, request.body as SourceRegistration, options));
  });

  router.post('/corpus/:did/sync', (request, response) => {
    const body = request.body as { source?: string; cursor?: string | null };
    if (!body?.source || sourceKind(body.source) === undefined) {
      response.status(501).json({ error: 'sync is not implemented for this source' });
      return;
    }

    handle(response, () => syncSource(engine, request.params.did, body.source as string, body.cursor ?? null, options));
  });

  router.post('/corpus/:did/crawl', (request, response) => {
    handle(response, () => {
      const body = request.body as { source?: string };
      if (!body?.source) {
        throw new Error('source is required');
      }

      return crawlSource(engine, request.params.did, body.source, options);
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

  router.get('/spec', (_request, response) => {
    response.type('yaml').send(readSpecText());
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

interface SourceRegistration {
  source?: string;
  type?: SourceType;
}

type SourceKind = 'workspace' | 'github';

const WORKSPACE_KIND: SourceKind = 'workspace';
const GITHUB_KIND: SourceKind = 'github';

const SOURCE_KIND_TYPE: Record<SourceKind, SourceType> = { [WORKSPACE_KIND]: 'local', [GITHUB_KIND]: 'github' };

/**
 * Identifies which registered adapter a source string belongs to, mirroring
 * the per-source-kind checks (`isWorkspaceSource`/`isGitHubSource`) each
 * adapter already exports — the corpus service has no central registry
 * object, just this dispatch by source prefix.
 */
function sourceKind(source: string): SourceKind | undefined {
  if (isWorkspaceSource(source)) return WORKSPACE_KIND;
  if (isGitHubSource(source)) return GITHUB_KIND;
  return undefined;
}

function unsupportedSourceError(source: string): Error {
  return new Error(`Unsupported source "${source}". Only "local:workspace" and "github:owner/repo" sources are supported.`);
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

async function crawlGitHubSource(engine: CorpusEngine, did: string, source: string): Promise<{ ingested: number }> {
  const adapter = new GitHubAdapter();
  const documents = await collectDocuments(adapter.fetch(source));

  return engine.ingest(did, documents);
}

async function syncGitHubSource(
  engine: CorpusEngine,
  did: string,
  source: string,
  cursor: string | null,
): Promise<{ ingested: number; cursor: string | null; hasMore: boolean }> {
  const adapter = new GitHubAdapter();
  const result = await adapter.sync(source, cursor);
  engine.ingest(did, result.documents);

  return { ingested: result.documents.length, cursor: result.cursor, hasMore: result.hasMore };
}

/**
 * Full crawl + ingest of `source`, dispatched to the adapter matching its
 * prefix. Shared by `/ingest` (with a `{ source }` body), `/crawl`, and
 * `/sources`.
 */
async function crawlSource(
  engine: CorpusEngine,
  did: string,
  source: string,
  options: WorkspaceOptions,
): Promise<{ ingested: number }> {
  const kind = sourceKind(source);
  if (kind === WORKSPACE_KIND) return crawlWorkspaceSource(engine, did, source, options);
  if (kind === GITHUB_KIND) return crawlGitHubSource(engine, did, source);
  throw unsupportedSourceError(source);
}

/** Incremental sync of `source`, dispatched to the adapter matching its prefix. */
async function syncSource(
  engine: CorpusEngine,
  did: string,
  source: string,
  cursor: string | null,
  options: WorkspaceOptions,
): Promise<{ ingested: number; cursor: string | null; hasMore: boolean }> {
  const kind = sourceKind(source);
  if (kind === WORKSPACE_KIND) return syncWorkspaceSource(engine, did, source, cursor, options);
  if (kind === GITHUB_KIND) return syncGitHubSource(engine, did, source, cursor);
  throw unsupportedSourceError(source);
}

/**
 * Registers a source for `did` and performs its initial full crawl —
 * `POST /corpus/:did/sources`. Body shape matches `isSourceRequest`
 * (`{ source }`), extended with an optional `type` that, when present, must
 * agree with the source string's own prefix so a caller can assert what kind
 * of source it expects to register.
 */
async function registerSource(
  engine: CorpusEngine,
  did: string,
  body: SourceRegistration,
  options: WorkspaceOptions,
): Promise<{ ingested: number }> {
  if (!body?.source) {
    throw new Error('source is required');
  }

  const kind = sourceKind(body.source);
  if (kind === undefined) {
    throw unsupportedSourceError(body.source);
  }
  if (body.type !== undefined && body.type !== SOURCE_KIND_TYPE[kind]) {
    throw new Error(`type "${body.type}" does not match source "${body.source}"`);
  }

  return crawlSource(engine, did, body.source, options);
}

const SPEC_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'api-spec', 'openapi.yaml');
let cachedSpecText: string | null = null;

/** Reads and caches the corpus OpenAPI spec served at `GET /spec` (#2020). */
function readSpecText(): string {
  if (cachedSpecText === null) {
    cachedSpecText = readFileSync(SPEC_FILE_PATH, 'utf-8');
  }
  return cachedSpecText;
}

async function handle<T>(response: Response, fn: () => T | Promise<T>): Promise<void> {
  try {
    response.json(await fn());
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'request failed' });
  }
}

// ─── Route inventory ─────────────────────────────────────────────────────────
// Lets a test assert `/spec` never drifts from the routes actually mounted
// below, without duplicating express's own internals in the type system.

export interface RouteEntry {
  method: string;
  path: string;
}

interface ExpressRouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
}

/** Converts an Express param path (`/corpus/:did/sync`) to its OpenAPI form (`/corpus/{did}/sync`). */
export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Every method+path this router actually serves, in OpenAPI path syntax. */
export function listRoutes(router: Router): RouteEntry[] {
  const layers = (router as unknown as { stack: ExpressRouteLayer[] }).stack;
  const routes: RouteEntry[] = [];

  for (const layer of layers) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({ method: method.toUpperCase(), path: toOpenApiPath(layer.route.path) });
    }
  }

  return routes;
}
