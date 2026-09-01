/**
 * OpenAI-compatible completions passthrough adapter (#1925).
 *
 * Covers every `BRAIN_CONNECTORS` entry whose `provider` is `'openai'` — today
 * Gemini and xAI, and the OpenAI/Moonshot entries landing in #1927/#1930 —
 * because they all speak the exact wire format the client already sent. There
 * is nothing to translate: the sealed `baseURL` + `apiKey` are handed straight
 * to the upstream host and its response — including raw SSE bytes and
 * `tool_calls` deltas — is forwarded back untouched. This IS the "passthrough"
 * the epic names: no AI SDK round-trip, no schema translation, so streaming
 * and tool-call fidelity are exactly what the upstream provider sent.
 *
 * The sealed key rides only the outgoing `Authorization` header. It is never
 * echoed into the client-facing response, and an upstream error body is
 * forwarded as-is rather than re-wrapped with request context that could leak
 * it — the same invariant the xAI models route (`#1924`) already holds.
 */
import { createLogger } from '@imajin/logger';
import type { ResolvedBrain } from '../brain';
import { fetchUpstream } from './errors';
import type { ChatCompletionsRequestBody, CompletionsRequestMetadata } from './types';

const log = createLogger('kernel:inference:completions:openai-compatible');

/**
 * Generous enough for a non-trivial completion (including tool round-trips
 * some providers pipeline server-side) without leaving a connection hanging
 * indefinitely on a provider that has gone dark.
 */
const UPSTREAM_TIMEOUT_MS = 120_000;

export async function forwardOpenAiCompatible(
  brain: ResolvedBrain,
  body: ChatCompletionsRequestBody,
  meta: CompletionsRequestMetadata,
): Promise<Response> {
  if (!brain.baseURL) {
    // Every current openai-compatible BRAIN_CONNECTORS entry declares a
    // defaultBaseUrl; this only trips if a future entry forgets to. Fail
    // loudly rather than silently falling back to some other host with this
    // DID's key.
    throw new Error(`completions_no_base_url: connector '${brain.connector}' has no baseURL configured`);
  }

  const upstreamBody = { ...body, model: brain.modelId };
  const upstreamUrl = `${brain.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const stream = Boolean(body.stream);

  log.info(
    {
      connector: brain.connector,
      model: brain.modelId,
      sessionId: meta.sessionId ?? null,
      turnId: meta.turnId ?? null,
      stream,
    },
    'completions passthrough: forwarding to OpenAI-compatible upstream',
  );

  const upstream = await fetchUpstream(
    brain.connector,
    upstreamUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${brain.apiKey}`,
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(upstreamBody),
    },
    UPSTREAM_TIMEOUT_MS,
  );

  if (!upstream.ok) {
    log.warn(
      { connector: brain.connector, status: upstream.status, sessionId: meta.sessionId ?? null, turnId: meta.turnId ?? null },
      'completions passthrough: upstream rejected the request',
    );
  }

  const headers = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  if (stream) {
    headers.set('Cache-Control', 'no-cache');
    headers.set('Connection', 'keep-alive');
  }

  // Forwarding `upstream.body` straight through IS the passthrough for both
  // shapes: a non-streaming JSON body arrives as one chunk, an SSE stream
  // arrives as many, and `Response` treats a `ReadableStream` body identically
  // either way — including a mid-stream upstream disconnect, which simply
  // ends the client's stream rather than needing special-case handling here.
  return new Response(upstream.body, { status: upstream.status, headers });
}
