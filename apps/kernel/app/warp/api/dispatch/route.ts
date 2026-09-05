/**
 * POST /warp/api/dispatch (#1428)
 *
 * Fire a Warp cloud agent as the session owner's DID, using *their* sealed Warp
 * Agent key. The run is stamped `{username}-jin` on Warp's side, so attribution
 * follows the credential rather than the human operating the session.
 *
 * Body:
 *   {
 *     "prompt": "…",                       // required
 *     "title"?: "…",
 *     "name"?: "…",                        // overrides the {username}-jin tag
 *     "modelId"?: "…",
 *     "basePrompt"?: "…",
 *     "environmentId"?: "…",
 *     "conversationId"?: "…",             // continue an existing conversation (#1939)
 *     "parentRunId"?: "…",                // orchestration lineage (#1939)
 *     "skillSpec"?: "owner/repo:skill",    // versioned SKILL.md as the payload
 *     "mcpServers"?: { name: { url, headers? } },
 *     "attachImajinMcp"?: boolean,         // attach mcp.imajin.ai (Wire B)
 *     "computerUseEnabled"?: boolean,
 *     "corpusContext"?: {                  // retrieve from the principal's own corpus (#2021)
 *       "source": "…",                     // required, e.g. "github:ima-jin/imajin-ai"
 *       "query": "…",                      // required
 *       "ref"?: "…",                       // pin to a previously-ingested git sha (#1921)
 *       "limit"?: 8,                       // 1-20, defaults to 8
 *       "maxChars"?: 6000                  // defaults to 6000
 *     }
 *   }
 *
 * Fails closed with 403 when the caller has no active `warp:dispatch` grant and
 * 409 when no key is sealed (or its grant was revoked). The key is never logged,
 * echoed, or included in any error body.
 *
 * When `corpusContext` is given, its DID is always the acting principal —
 * never a caller-supplied value — and a search failure (corpus unreachable,
 * an unknown `ref`, an access-claim rejection) fails the dispatch itself
 * with `corpus_context_failed` rather than silently proceeding without the
 * requested context (#2021).
 *
 * On success the run is also watched to completion in the background (#1639), so
 * `warp.run.completed` lands on the bus without the caller polling for it. The
 * same watch reports the run while it is still going as `warp.run.progress`
 * (#1682), so the caller sees state changes, new tool calls, cost, and early
 * errors instead of a silence that only ends at the outcome.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { CORPUS_CONTEXT_MAX_LIMIT, type CorpusContextInput } from '@/src/lib/warp/corpus-context';
import {
  dispatchAgentRun,
  watchRun,
  type DispatchAgentRunInput,
  type WarpMcpServerConfig,
} from '@/src/lib/warp/dispatch';
import { warpErrorResponse } from '@/src/lib/warp/route-errors';

/** Upper bound on `corpusContext.maxChars` accepted from a caller before it is treated as malformed. */
const CORPUS_CONTEXT_MAX_CHARS_CEILING = 100_000;

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/** Optional non-empty string field, or undefined when absent or malformed. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Pass-through of the caller's `mcp_servers` map.
 *
 * Only the map shape is validated here; Warp owns the per-server schema and
 * rejects a malformed entry with a problem document we surface verbatim. Doing
 * our own field-level validation would mean re-implementing (and drifting from)
 * their transport rules.
 */
function optionalMcpServers(value: unknown): Record<string, WarpMcpServerConfig> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, WarpMcpServerConfig>;
}

/** A finite number within `[min, max]`, or undefined when the raw value was absent. */
function optionalBoundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Parse the optional `corpusContext` body field.
 *
 * Rejected outright rather than silently dropped when malformed: a caller who
 * asked for retrieval context and got a typo-silenced no-op would see a run
 * dispatched without the context they thought they required — the same
 * fail-closed reasoning `corpus-context.ts` applies to a corpus-side failure.
 * The corpus DID is deliberately never read from this body — `dispatchAgentRun`
 * always searches the acting principal's own corpus (#2021).
 */
function parseCorpusContext(value: unknown): { corpusContext?: CorpusContextInput; error?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'corpusContext must be an object' };
  }

  const body = value as Record<string, unknown>;
  const source = optionalString(body.source);
  const query = optionalString(body.query);
  if (source === undefined || query === undefined) {
    return { error: 'corpusContext.source and corpusContext.query must be non-empty strings' };
  }

  const ref = optionalString(body.ref);
  const limit = optionalBoundedNumber(body.limit, 1, CORPUS_CONTEXT_MAX_LIMIT);
  const maxChars = optionalBoundedNumber(body.maxChars, 1, CORPUS_CONTEXT_MAX_CHARS_CEILING);

  return {
    corpusContext: {
      source,
      query,
      ...(ref === undefined ? {} : { ref }),
      ...(limit === undefined ? {} : { limit }),
      ...(maxChars === undefined ? {} : { maxChars }),
    },
  };
}

/** Build the `DispatchAgentRunInput` from a validated `prompt`/`corpusContext` and the raw body. */
function buildDispatchInput(
  prompt: string,
  corpusContext: CorpusContextInput | undefined,
  body: Record<string, unknown>,
): DispatchAgentRunInput {
  return {
    prompt,
    ...(corpusContext === undefined ? {} : { corpusContext }),
    ...(optionalString(body.title) === undefined ? {} : { title: optionalString(body.title) }),
    ...(optionalString(body.name) === undefined ? {} : { name: optionalString(body.name) }),
    ...(optionalString(body.modelId) === undefined ? {} : { modelId: optionalString(body.modelId) }),
    ...(optionalString(body.basePrompt) === undefined
      ? {}
      : { basePrompt: optionalString(body.basePrompt) }),
    ...(optionalString(body.environmentId) === undefined
      ? {}
      : { environmentId: optionalString(body.environmentId) }),
    ...(optionalString(body.conversationId) === undefined
      ? {}
      : { conversationId: optionalString(body.conversationId) }),
    ...(optionalString(body.parentRunId) === undefined
      ? {}
      : { parentRunId: optionalString(body.parentRunId) }),
    ...(optionalString(body.skillSpec) === undefined
      ? {}
      : { skillSpec: optionalString(body.skillSpec) }),
    ...(optionalMcpServers(body.mcpServers) === undefined
      ? {}
      : { mcpServers: optionalMcpServers(body.mcpServers) }),
    ...(optionalBoolean(body.attachImajinMcp) === undefined
      ? {}
      : { attachImajinMcp: optionalBoolean(body.attachImajinMcp) }),
    ...(optionalBoolean(body.computerUseEnabled) === undefined
      ? {}
      : { computerUseEnabled: optionalBoolean(body.computerUseEnabled) }),
  };
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const principalDid = resolveActingDid(auth.identity);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const prompt = optionalString(body.prompt);
  if (!prompt) {
    return NextResponse.json(
      { error: 'prompt must be a non-empty string' },
      { status: 400, headers: cors },
    );
  }

  const { corpusContext, error: corpusContextError } = parseCorpusContext(body.corpusContext);
  if (corpusContextError !== undefined) {
    return NextResponse.json({ error: corpusContextError }, { status: 400, headers: cors });
  }

  const input = buildDispatchInput(prompt, corpusContext, body);

  try {
    const run = await dispatchAgentRun(principalDid, input);

    // Fire-and-forget, deliberately un-awaited: the watch polls for up to 30
    // minutes, so putting it in the response path would turn a 201 into a
    // timeout. `watchRun` never rejects, so there is nothing here to catch — it
    // logs its own failures and the dispatch stands either way.
    void watchRun(principalDid, run.runId);

    return NextResponse.json(run, { status: 201, headers: cors });
  } catch (err) {
    log.error({ err: String(err), principalDid }, 'Warp dispatch failed');
    return warpErrorResponse(err, cors);
  }
}
