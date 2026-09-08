import express, { type Request, type Response, type Router } from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubAdapter, isGitHubSource } from './adapters/github';
import { LocalAdapter } from './adapters/local';
import { CorpusEngine } from './engine';
import { AttestationNotFoundError, UnknownRefError } from './engine/errors';
import type { CorpusSearchRequest, SourceType, ThreadDocument } from './engine/types';
import { resolveGitRef } from './lib/git';
import { isWorkspaceSource, resolveWorkspacePath, validateSourcePath, workspaceRootForDid, type WorkspaceOptions } from './lib/workspace';
// Service DID + ingestion-attestation signing (#1750, folded into #2021's
// checklist) lands here: claim verification (middleware/access-claim.ts)
// plus the corpus identity + signing/forwarding wired through engine/index.ts.
import { createAccessClaimMiddleware } from './middleware/access-claim';

export type CorpusRouterOptions = WorkspaceOptions;

export function createCorpusRouter(engine: CorpusEngine, options: CorpusRouterOptions = {}): Router {
  const router = express.Router();

  // Single choke point for every /corpus/:did/* route (#1751). /health and
  // /spec (#2020) stay outside this prefix and remain public.
  router.use('/corpus/:did', createAccessClaimMiddleware());

  router.post('/corpus/:did/ingest', (request, response) => {
    handle(response, async () => {
      const body: unknown = request.body;
      const did = request.params.did;
      const ingesterDid = ingesterDidFor(request);

      if (isSourceRequest(body)) {
        const result = await crawlSource(engine, did, body.source, options, ingesterDid);
        triggerEmbedSweep(engine, did);
        return result;
      }

      if (!Array.isArray(body)) {
        throw new Error('body must be a ThreadDocument[] or { source }');
      }

      const result = engine.ingest(did, body as ThreadDocument[], undefined, ingesterDid);
      triggerEmbedSweep(engine, did);
      return result;
    });
  });

  router.post('/corpus/:did/search', (request, response) => {
    handle(response, () => engine.search(request.params.did, request.body as CorpusSearchRequest));
  });

  router.post('/corpus/:did/sources', (request, response) => {
    handle(response, async () => {
      const result = await registerSource(engine, request.params.did, request.body as SourceRegistration, options, ingesterDidFor(request));
      triggerEmbedSweep(engine, request.params.did);
      return result;
    });
  });

  router.post('/corpus/:did/sync', (request, response) => {
    const body = request.body as { source?: string; cursor?: string | null };
    if (!body?.source || sourceKind(body.source) === undefined) {
      response.status(501).json({ error: 'sync is not implemented for this source' });
      return;
    }

    handle(response, async () => {
      const result = await syncSource(engine, request.params.did, body.source as string, body.cursor ?? null, options, ingesterDidFor(request));
      triggerEmbedSweep(engine, request.params.did);
      return result;
    });
  });

  router.post('/corpus/:did/crawl', (request, response) => {
    handle(response, async () => {
      const body = request.body as { source?: string };
      if (!body?.source) {
        throw new Error('source is required');
      }

      const result = await crawlSource(engine, request.params.did, body.source, options, ingesterDidFor(request));
      triggerEmbedSweep(engine, request.params.did);
      return result;
    });
  });

  router.get('/corpus/:did/status', (request, response) => {
    handle(response, () => engine.status(request.params.did));
  });

  router.get('/corpus/:did/attestations/:id', (request, response) => {
    handle(response, () => engine.getAttestation(request.params.did, request.params.id));
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

/**
 * Kicks off a non-blocking embedding sweep after an ingest-shaped route
 * writes new/changed threads (#1599, #1601) — "async/batched" per the
 * ticket: the HTTP response for the triggering route is not held up by it,
 * and a PGX failure here never surfaces as a request error since
 * `embedPending` already fails closed (leaves chunks `pending` for retry).
 */
function triggerEmbedSweep(engine: CorpusEngine, did: string): void {
  void engine.embedPending(did).catch(() => {});
}

async function collectDocuments(iterable: AsyncIterable<ThreadDocument>): Promise<ThreadDocument[]> {
  const documents: ThreadDocument[] = [];
  for await (const document of iterable) {
    documents.push(document);
  }
  return documents;
}

/** Reads the DID the verified CorpusAccessClaim authorized this request for, falling back to the `:did` path param (e.g. for tests that bypass the middleware). */
function ingesterDidFor(request: Request): string {
  if (request.corpusAccessClaim?.did) {
    return request.corpusAccessClaim.did;
  }
  const paramDid = request.params.did;
  return Array.isArray(paramDid) ? paramDid[0] : paramDid;
}

async function crawlWorkspaceSource(
  engine: CorpusEngine,
  did: string,
  source: string,
  options: WorkspaceOptions,
  ingesterDid: string,
): Promise<{ ingested: number }> {
  const resolvedPath = resolveLocalWorkspaceSource(did, source, options);
  const adapter = new LocalAdapter();
  const documents = rewriteSource(await collectDocuments(adapter.fetch(`local:${resolvedPath}`)), source);

  return engine.ingest(did, documents, resolveGitRef(resolvedPath), ingesterDid);
}

async function syncWorkspaceSource(
  engine: CorpusEngine,
  did: string,
  source: string,
  cursor: string | null,
  options: WorkspaceOptions,
  ingesterDid: string,
): Promise<{ ingested: number; cursor: string | null; hasMore: boolean }> {
  const resolvedPath = resolveLocalWorkspaceSource(did, source, options);
  const adapter = new LocalAdapter();
  const result = await adapter.sync(`local:${resolvedPath}`, cursor);
  const documents = rewriteSource(result.documents, source);
  engine.ingest(did, documents, resolveGitRef(resolvedPath), ingesterDid);

  return { ingested: documents.length, cursor: result.cursor, hasMore: result.hasMore };
}

async function crawlGitHubSource(engine: CorpusEngine, did: string, source: string, ingesterDid: string): Promise<{ ingested: number }> {
  const adapter = new GitHubAdapter();
  const documents = await collectDocuments(adapter.fetch(source));

  return engine.ingest(did, documents, undefined, ingesterDid);
}

async function syncGitHubSource(
  engine: CorpusEngine,
  did: string,
  source: string,
  cursor: string | null,
  ingesterDid: string,
): Promise<{ ingested: number; cursor: string | null; hasMore: boolean }> {
  const adapter = new GitHubAdapter();
  const result = await adapter.sync(source, cursor);
  engine.ingest(did, result.documents, undefined, ingesterDid);

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
  ingesterDid: string,
): Promise<{ ingested: number }> {
  const kind = sourceKind(source);
  if (kind === WORKSPACE_KIND) return crawlWorkspaceSource(engine, did, source, options, ingesterDid);
  if (kind === GITHUB_KIND) return crawlGitHubSource(engine, did, source, ingesterDid);
  throw unsupportedSourceError(source);
}

/** Incremental sync of `source`, dispatched to the adapter matching its prefix. */
async function syncSource(
  engine: CorpusEngine,
  did: string,
  source: string,
  cursor: string | null,
  options: WorkspaceOptions,
  ingesterDid: string,
): Promise<{ ingested: number; cursor: string | null; hasMore: boolean }> {
  const kind = sourceKind(source);
  if (kind === WORKSPACE_KIND) return syncWorkspaceSource(engine, did, source, cursor, options, ingesterDid);
  if (kind === GITHUB_KIND) return syncGitHubSource(engine, did, source, cursor, ingesterDid);
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
  ingesterDid: string,
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

  return crawlSource(engine, did, body.source, options, ingesterDid);
}

const SPEC_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'api-spec', 'openapi.yaml');
let cachedSpecText: string | null = null;

/** Reads and caches the corpus OpenAPI spec served at `GET /spec` (#2020). */
function readSpecText(): string {
  cachedSpecText ??= readFileSync(SPEC_FILE_PATH, 'utf-8');
  return cachedSpecText;
}

async function handle<T>(response: Response, fn: () => T | Promise<T>): Promise<void> {
  try {
    response.json(await fn());
  } catch (error) {
    if (error instanceof UnknownRefError) {
      response.status(404).json({ error: error.message, hint: 'trigger ingest at this ref' });
      return;
    }
    if (error instanceof AttestationNotFoundError) {
      response.status(404).json({ error: error.message });
      return;
    }
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
