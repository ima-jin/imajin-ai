/**
 * Anthropic Messages API raw-byte passthrough (#1959, sub-issue of #1922).
 *
 * Distinct from `completions/anthropic-adapter.ts`'s `forwardAnthropic`
 * (#1925): that adapter translates an OpenAI-shaped request through the AI
 * SDK because its caller sent OpenAI-shaped bytes. This module's caller
 * already sends Anthropic-shaped bytes (the Claude Agent SDK / Claude Code
 * CLI via `ANTHROPIC_BASE_URL`), so there is nothing to translate — per
 * Jin's review note 1 on #1959, this is a byte-for-byte forward to
 * `https://api.anthropic.com`: swap the auth header, forward the body,
 * stream the response back unchanged. No AI SDK in the hot path.
 *
 * Shares its upstream-call/timeout plumbing (`fetchUpstream`,
 * `UpstreamTimeoutError`/`UpstreamUnavailableError`) and its metering sink
 * (`recordInferenceUsage`) with the OpenAI-compatible adapter rather than
 * re-implementing either — only the Anthropic-specific pieces (headers,
 * endpoint paths, and the `message_start`/`message_delta` usage split) are
 * new here.
 */
import { createLogger } from '@imajin/logger';
import type { ResolvedBrain } from '../brain';
import { fetchUpstream } from '../completions/errors';
import type { CompletionsRequestMetadata } from '../completions/types';
import { recordInferenceUsage } from '../usage-ledger';

const log = createLogger('kernel:inference:anthropic-messages');

/** Matches the OpenAI-compatible and Anthropic (AI SDK) adapters' upstream deadline. */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** Anthropic's public API base — the raw-passthrough target, distinct from `ANTHROPIC_BASE_URL` in `anthropic/connector.ts` (that one backs the model-picker route, same value). */
export const ANTHROPIC_MESSAGES_BASE_URL = 'https://api.anthropic.com/v1';

/** Pinned the same way `anthropic/api/models/route.ts` and `lib/usage/billed/anthropic.ts` pin it. */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/** `anthropic-version`/`anthropic-beta` request headers, forwarded unchanged per the gateway protocol (verified 2026-09-02, see the route header for the full citation). */
export interface AnthropicRequestHeaders {
  anthropicVersion?: string;
  anthropicBeta?: string;
}

export interface PreparedAnthropicBody {
  /** The request body with `model` overridden to the sealed connector's `modelId` — see `applySealedModel`. */
  value: string;
  /** Whether the (post-override) body requested a streamed response. */
  stream: boolean;
}

/**
 * Parse the client's JSON body and override `model` with the sealed
 * connector's `modelId` (#1959 deliverable 1: "the SEALED modelId wins" —
 * the same precedent `forwardOpenAiCompatible` already sets for the
 * OpenAI-compatible passthrough, `{ ...body, model: brain.modelId }`, and
 * `forwardAnthropic`'s AI-SDK adapter sets implicitly by always calling
 * `getModel(brain.provider, brain.modelId, ...)` regardless of what the
 * client sent). The sealed key chose its model when it was granted; letting
 * a client's `model` field override it would let a delegated caller spend a
 * principal's credential on a model the principal never approved.
 *
 * This is the one field this "raw byte passthrough" does not forward
 * byte-for-byte — every other field, and the client's own key order, pass
 * through the parse/re-stringify untouched.
 */
export function applySealedModel(
  bodyText: string,
  modelId: string,
): { ok: true; value: PreparedAnthropicBody } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: 'Invalid JSON body' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const body = parsed as Record<string, unknown>;
  const stream = body.stream === true;
  return { ok: true, value: { value: JSON.stringify({ ...body, model: modelId }), stream } };
}

function upstreamHeaders(brain: ResolvedBrain, headers: AnthropicRequestHeaders, accept: string): Record<string, string> {
  const out: Record<string, string> = {
    'Content-Type': 'application/json',
    // Jin's review note 3: the SDK/CLI authenticate api.anthropic.com with
    // x-api-key, never a bearer — this is the "swap the auth header" the
    // issue calls for. The sealed key never reaches the client in either
    // direction (never logged, never echoed on a response).
    'x-api-key': brain.apiKey,
    'anthropic-version': headers.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
    Accept: accept,
  };
  // Forwarded unchanged per the gateway protocol, when the caller sent one —
  // never allowlisted to individual values, since the beta set changes with
  // Claude Code releases (see the route header's citation).
  if (headers.anthropicBeta) out['anthropic-beta'] = headers.anthropicBeta;
  return out;
}

function responseHeaders(upstream: Response, stream: boolean): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  if (stream) {
    headers.set('Cache-Control', 'no-cache');
    headers.set('Connection', 'keep-alive');
  }
  return headers;
}

/**
 * Forward one `POST /v1/messages` call. Metered: writes one `usage.incurred`
 * row via `recordInferenceUsage`, parsed from the Anthropic-shaped `usage`
 * object (split across `message_start`/`message_delta` on the stream — see
 * `recordAnthropicMessagesUsage`/`meterAnthropicMessagesStream` below).
 */
export async function forwardAnthropicMessages(
  brain: ResolvedBrain,
  body: PreparedAnthropicBody,
  meta: CompletionsRequestMetadata,
  headers: AnthropicRequestHeaders,
): Promise<Response> {
  log.info(
    {
      connector: brain.connector,
      model: brain.modelId,
      sessionId: meta.sessionId ?? null,
      turnId: meta.turnId ?? null,
      stream: body.stream,
    },
    'anthropic messages passthrough: forwarding to api.anthropic.com',
  );

  const upstream = await fetchUpstream(
    brain.connector,
    `${ANTHROPIC_MESSAGES_BASE_URL}/messages`,
    {
      method: 'POST',
      headers: upstreamHeaders(brain, headers, body.stream ? 'text/event-stream' : 'application/json'),
      body: body.value,
    },
    UPSTREAM_TIMEOUT_MS,
  );

  if (!upstream.ok) {
    log.warn(
      { connector: brain.connector, status: upstream.status, sessionId: meta.sessionId ?? null, turnId: meta.turnId ?? null },
      'anthropic messages passthrough: upstream rejected the request',
    );
  }

  const outHeaders = responseHeaders(upstream, body.stream);

  if (body.stream && upstream.body) {
    const [clientBody, meterBody] = upstream.body.tee();
    meterAnthropicMessagesStream(meterBody, brain, meta);
    return new Response(clientBody, { status: upstream.status, headers: outHeaders });
  }

  const text = await upstream.text();
  await recordAnthropicMessagesUsage(text, brain, meta);
  return new Response(text, { status: upstream.status, headers: outHeaders });
}

/**
 * Forward one `POST /v1/messages/count_tokens` call (#1959 deliverable 1 —
 * enumerated in the route header as part of the verified SDK surface).
 *
 * Deliberately unmetered: token counting is not a billed Anthropic call, and
 * the epic's metering contract (#1959 deliverable 2) is explicit that
 * `count_tokens` calls are not `usage.incurred` events. No spend-cap check
 * either, for the same reason — there is nothing here that spends budget.
 */
export async function forwardAnthropicCountTokens(
  brain: ResolvedBrain,
  bodyValue: string,
  headers: AnthropicRequestHeaders,
): Promise<Response> {
  const upstream = await fetchUpstream(
    brain.connector,
    `${ANTHROPIC_MESSAGES_BASE_URL}/messages/count_tokens`,
    {
      method: 'POST',
      headers: upstreamHeaders(brain, headers, 'application/json'),
      body: bodyValue,
    },
    UPSTREAM_TIMEOUT_MS,
  );

  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: responseHeaders(upstream, false) });
}

/**
 * Forward one `GET /v1/models` call (#1959 deliverable 1 — the route header
 * marks this optional: only reached when a caller opts into
 * `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`). Unmetered and
 * uncapped for the same reason as `count_tokens` — listing models spends
 * nothing.
 */
export async function forwardAnthropicModelsList(brain: ResolvedBrain, querySuffix: string): Promise<Response> {
  const upstream = await fetchUpstream(
    brain.connector,
    `${ANTHROPIC_MESSAGES_BASE_URL}/models${querySuffix}`,
    { method: 'GET', headers: upstreamHeaders(brain, {}, 'application/json') },
    UPSTREAM_TIMEOUT_MS,
  );

  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: responseHeaders(upstream, false) });
}

/** Anthropic's `usage` shape, as carried on both the non-streaming JSON body and the streaming `message_start`/`message_delta` events. */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Write the `usage.incurred` row for one call (#1959 deliverable 2).
 * `quantity` (computed inside `recordInferenceUsage`) is `tokensIn +
 * tokensOut` — `input_tokens`/`output_tokens` only. The cache fields ride in
 * `metadata` rather than folding into `tokensIn`, exactly as Jin's review
 * note 4 specifies ("map into the same usage.incurred row shape … metadata
 * carries the cache fields") — Anthropic bills cache writes and cache reads
 * at different rates than a fresh input token, so collapsing them into one
 * number would erase the distinction the metadata is there to preserve.
 * Never throws: `recordInferenceUsage` itself is fail-open (never turns a
 * metering hiccup into a failed completion already served to the caller).
 */
async function writeAnthropicMessagesUsage(
  brain: ResolvedBrain,
  meta: CompletionsRequestMetadata,
  usage: AnthropicUsage,
): Promise<void> {
  await recordInferenceUsage({
    sessionId: meta.sessionId,
    turnId: meta.turnId,
    principalDid: brain.credentialDid,
    agentDid: meta.agentDid,
    provider: brain.connector,
    model: brain.modelId,
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    metadata: {
      format: 'anthropic-messages',
      ...(usage.cache_creation_input_tokens !== undefined
        ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
        : {}),
      ...(usage.cache_read_input_tokens !== undefined ? { cacheReadInputTokens: usage.cache_read_input_tokens } : {}),
    },
  });
}

/**
 * Parse a non-streaming JSON response body for `usage` and write the row.
 * Never throws: a body this adapter does not understand still gets a
 * degraded row with null tokens rather than none at all, matching the
 * OpenAI-compatible adapter's `recordOpenAiCompatibleUsage` precedent.
 */
async function recordAnthropicMessagesUsage(
  rawBody: string,
  brain: ResolvedBrain,
  meta: CompletionsRequestMetadata,
): Promise<void> {
  let usage: AnthropicUsage | undefined;
  try {
    usage = (JSON.parse(rawBody) as { usage?: AnthropicUsage }).usage;
  } catch {
    // Not JSON (or not an object) — nothing to meter from, record the call anyway.
  }
  await writeAnthropicMessagesUsage(brain, meta, usage ?? {});
}

/** Extract usage fields from one Anthropic SSE `data:` line, merging into `acc` in place. */
function mergeSseUsageLine(line: string, acc: AnthropicUsage): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return;
  const payload = trimmed.slice(5).trim();
  if (payload.length === 0) return;

  let event: { type?: string; message?: { usage?: AnthropicUsage }; usage?: AnthropicUsage };
  try {
    event = JSON.parse(payload) as typeof event;
  } catch {
    return;
  }

  // #1959 Jin's review note 4: input_tokens (+ the two cache fields) arrive
  // on `message_start`; output_tokens arrives on `message_delta` — Anthropic
  // never repeats input_tokens there, so both events are read, not just one.
  if (event.type === 'message_start' && event.message?.usage) {
    acc.input_tokens = event.message.usage.input_tokens;
    acc.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens;
    acc.cache_read_input_tokens = event.message.usage.cache_read_input_tokens;
  } else if (event.type === 'message_delta' && event.usage?.output_tokens !== undefined) {
    acc.output_tokens = event.usage.output_tokens;
  }
}

/**
 * Drain a teed copy of the upstream SSE stream to find the split usage
 * events, then write the row. Runs independently of the client-facing
 * stream — a slow or malformed tap must never affect what the client
 * receives — mirroring `openai-compatible-adapter.ts`'s `meterStreamForUsage`.
 */
function meterAnthropicMessagesStream(
  body: ReadableStream<Uint8Array>,
  brain: ResolvedBrain,
  meta: CompletionsRequestMetadata,
): void {
  (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const usage: AnthropicUsage = {};

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        mergeSseUsageLine(line, usage);
      }
    }

    await writeAnthropicMessagesUsage(brain, meta, usage);
  })().catch((err: unknown) => {
    log.warn({ err: String(err), connector: brain.connector }, 'anthropic messages passthrough: usage stream tap failed');
  });
}
