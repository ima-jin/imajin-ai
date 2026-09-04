/**
 * MCP corpus proxy tools (#1730).
 *
 * The kernel is the auth gateway; the corpus engine (`apps/corpus/`, #1728) is
 * the backend that actually indexes and searches threads. These tools do
 * nothing but:
 *   1. Check the caller's scope (`corpus:read` / `corpus:write`), via the same
 *      per-tool `requiredScope` gate every other MCP tool uses (server.ts).
 *   2. Proxy the call to the corpus service over the internal network, with
 *      `ctx.did` — the resource-owner DID from the verified access token — as
 *      the `:did` path parameter. No tool here can reach another DID's corpus:
 *      the DID is never taken from tool arguments, only from `ctx`.
 *   3. Return whatever the corpus service answered.
 *
 * No indexing/search/sync logic lives here — see apps/corpus/src/engine for
 * that. The kernel does not depend on apps/corpus; the two talk HTTP.
 *
 * Template: modelled on tools/inference.ts + tools/warp.ts (thin proxy to an
 * out-of-process service, in-band error return, ctx.did as the owner key).
 * RFC-32 federated-growth contract: only this file + tools/index.ts change.
 */
import type { McpTool } from '../types';
import { str, num, json } from './utils';
import { corpusAccessClaimHeader, type CorpusAccessScope } from '../../kernel/corpus-access-claim';

// ── HTTP proxy ─────────────────────────────────────────────────────────────

/** Base URL of the corpus service (internal network only). */
function corpusServiceUrl(): string {
  return process.env.CORPUS_SERVICE_URL || 'http://localhost:8003';
}

/**
 * Call `/corpus/:did/<path>` on the corpus service and return the parsed JSON
 * body. Every call carries a fresh, kernel-signed `CorpusAccessClaim` (#1772)
 * scoped to `did`/`scope`, so the corpus service can verify the caller may
 * act as `did` without a per-request callback to the kernel. Throws on a
 * non-2xx response so the MCP dispatch's try/catch in server.ts turns it into
 * an in-band `isError` result, same as every other tool's failure path.
 */
async function corpusRequest(
  method: 'GET' | 'POST',
  did: string,
  scope: CorpusAccessScope,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${corpusServiceUrl()}/corpus/${encodeURIComponent(did)}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: await corpusAccessClaimHeader(did, scope),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON body (e.g. an empty error page from an intermediary). The status
    // code alone still drives the ok/error branch below.
  }

  if (!response.ok) {
    const errorMessage =
      payload !== null && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : response.statusText || 'request failed';
    throw new Error(`corpus_service_error: ${response.status} ${errorMessage}`);
  }

  return payload;
}

// ── Arg helpers ─────────────────────────────────────────────────────────────

/** A single string, or an array of strings — the shape `state`/`type` take. */
function stringOrStringArray(args: Record<string, unknown>, key: string): string | string[] | undefined {
  const value = args[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return undefined;
}

function stringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

// ── corpus_search ────────────────────────────────────────────────────────────

const stringOrArraySchema = {
  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
} as const;

const searchTool: McpTool = {
  name: 'corpus_search',
  requiredScope: 'corpus:read',
  description:
    'Search your corpus for prior threads matching a query. Returns evidence (quotes ' +
    '+ state + link), not conclusions. Requires an active corpus:read grant.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query text.' },
      sourceType: { type: 'string', description: 'Filter by source type, e.g. "github" or "discord".' },
      source: { type: 'string', description: 'Filter by a specific source, e.g. "github:ima-jin/imajin-ai".' },
      state: {
        ...stringOrArraySchema,
        description: 'Filter by thread state (or a list of states), e.g. "open" or ["open", "draft"].',
      },
      type: {
        ...stringOrArraySchema,
        description: 'Filter by thread type (or a list of types), e.g. "issue" or ["issue", "pr"].',
      },
      labels: { type: 'array', items: { type: 'string' }, description: 'Filter by label names.' },
      author: { type: 'string', description: 'Filter by author.' },
      limit: { type: 'number', description: 'Max results to return.' },
      budget: { type: 'number', description: 'Token budget for evidence excerpts.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const query = str(args, 'query');
    if (query === undefined) throw new Error('query is required');

    const sourceType = str(args, 'sourceType');
    const source = str(args, 'source');
    const state = stringOrStringArray(args, 'state');
    const type = stringOrStringArray(args, 'type');
    const labels = stringArray(args, 'labels');
    const author = str(args, 'author');
    const limit = num(args, 'limit');
    const budget = num(args, 'budget');

    const result = await corpusRequest('POST', ctx.did, 'corpus:read', '/search', {
      query,
      ...(sourceType === undefined ? {} : { sourceType }),
      ...(source === undefined ? {} : { source }),
      ...(state === undefined ? {} : { state }),
      ...(type === undefined ? {} : { type }),
      ...(labels === undefined ? {} : { labels }),
      ...(author === undefined ? {} : { author }),
      ...(limit === undefined ? {} : { limit }),
      ...(budget === undefined ? {} : { budget }),
    });

    return json(result);
  },
};

// ── corpus_load ──────────────────────────────────────────────────────────────

const loadTool: McpTool = {
  name: 'corpus_load',
  requiredScope: 'corpus:write',
  description: 'Load thread documents into your corpus from a source. Requires an active corpus:write grant.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'The source these documents came from, e.g. "github:ima-jin/imajin-ai".' },
      documents: {
        type: 'array',
        items: { type: 'object' },
        description: 'ThreadDocument objects to ingest (issues, PRs, discussions, docs, etc.).',
      },
    },
    required: ['source', 'documents'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const source = str(args, 'source');
    if (source === undefined) throw new Error('source is required');

    const documents = args.documents;
    if (!Array.isArray(documents)) throw new Error('documents must be an array of ThreadDocument');

    const result = await corpusRequest('POST', ctx.did, 'corpus:write', '/ingest', documents);
    return json(result);
  },
};

// ── corpus_sync ──────────────────────────────────────────────────────────────

const syncTool: McpTool = {
  name: 'corpus_sync',
  requiredScope: 'corpus:write',
  description: 'Trigger incremental refresh of corpus sources. Requires an active corpus:write grant.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Optional source to sync. Omit to sync every source.' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const source = str(args, 'source');
    const result = await corpusRequest('POST', ctx.did, 'corpus:write', '/sync', source === undefined ? {} : { source });
    return json(result);
  },
};

// ── corpus_status ────────────────────────────────────────────────────────────

const statusTool: McpTool = {
  name: 'corpus_status',
  requiredScope: 'corpus:read',
  description:
    "Show what's indexed in your corpus — sources, thread counts, freshness. Requires an active corpus:read grant.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_args, ctx) {
    const result = await corpusRequest('GET', ctx.did, 'corpus:read', '/status');
    return json(result);
  },
};

export const corpusTools: McpTool[] = [searchTool, loadTool, syncTool, statusTool];
