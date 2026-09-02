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
import { recordInferenceUsage } from '../usage-ledger';

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

  const stream = Boolean(body.stream);
  // #1923: ask OpenAI-compatible upstreams to emit a final usage-bearing SSE
  // chunk so a streaming call is meterable without breaking the "raw byte
  // passthrough" contract for the client-facing bytes themselves (see
  // `meterStreamForUsage` below — it taps a SEPARATE teed branch, the client
  // branch is untouched). Non-streaming requests are left exactly as before
  // (`{ ...body, model: brain.modelId }`): every OpenAI-compatible provider
  // already includes `usage` on the plain JSON response with no extra field
  // needed.
  const upstreamBody = stream
    ? { ...body, model: brain.modelId, stream_options: { include_usage: true } }
    : { ...body, model: brain.modelId };
  const upstreamUrl = `${brain.baseURL.replace(/\/+$/, '')}/chat/completions`;

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

  // #1923: every call writes one inference.usage row, but HOW usage is read
  // off differs by shape so the client-facing bytes stay an untouched
  // passthrough either way:
  //   - non-streaming: the whole body is one JSON blob anyway, so buffering
  //     it once to read `.usage` before forwarding costs nothing a raw
  //     passthrough wasn't already going to do (one round trip either way).
  //   - streaming: `tee()` splits the upstream body into two independent
  //     streams — one returned to the client byte-for-byte untouched, the
  //     other drained internally by `meterStreamForUsage` to find the final
  //     usage-bearing SSE chunk `stream_options.include_usage` asked for.
  //     Metering never delays or alters what the client receives.
  if (stream && upstream.body) {
    const [clientBody, meterBody] = upstream.body.tee();
    meterStreamForUsage(meterBody, brain, meta);
    return new Response(clientBody, { status: upstream.status, headers });
  }

  const text = await upstream.text();
  await recordOpenAiCompatibleUsage(text, brain, meta);
  return new Response(text, { status: upstream.status, headers });
}

/** OpenAI wire-format `usage`, as carried on both the JSON and SSE shapes. */
interface OpenAiCompatibleUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Parse a non-streaming JSON response body for `usage` and write the
 * inference.usage row. Never throws: a body this adapter does not
 * understand (or a provider that omits `usage` entirely) still gets a
 * degraded row with null tokens rather than none at all. Awaited by the
 * caller before the response is returned — the whole body is already
 * buffered by this point, so there is no streaming latency left to protect.
 */
async function recordOpenAiCompatibleUsage(rawBody: string, brain: ResolvedBrain, meta: CompletionsRequestMetadata): Promise<void> {
  let usage: OpenAiCompatibleUsage | undefined;
  try {
    usage = (JSON.parse(rawBody) as { usage?: OpenAiCompatibleUsage }).usage;
  } catch {
    // Not JSON (or not an object) — nothing to meter from, record the call anyway.
  }

  try {
    await recordInferenceUsage({
      sessionId: meta.sessionId,
      turnId: meta.turnId,
      principalDid: brain.credentialDid,
      agentDid: meta.agentDid,
      provider: brain.connector,
      model: brain.modelId,
      tokensIn: usage?.prompt_tokens,
      tokensOut: usage?.completion_tokens,
    });
  } catch (err) {
    log.error({ err: String(err), connector: brain.connector }, 'completions passthrough: usage ledger write failed');
  }
}

/**
 * Drain a teed copy of the upstream SSE stream looking for the final
 * usage-bearing chunk, then write the inference.usage row. Runs
 * independently of the client-facing stream — a slow or malformed tap must
 * never affect what the client receives, so every failure here is caught
 * and logged rather than propagated.
 */
function meterStreamForUsage(
  body: ReadableStream<Uint8Array>,
  brain: ResolvedBrain,
  meta: CompletionsRequestMetadata,
): void {
  (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: OpenAiCompatibleUsage | undefined;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const found = parseSseUsageLine(line);
        if (found) usage = found;
      }
    }

    await recordInferenceUsage({
      sessionId: meta.sessionId,
      turnId: meta.turnId,
      principalDid: brain.credentialDid,
      agentDid: meta.agentDid,
      provider: brain.connector,
      model: brain.modelId,
      tokensIn: usage?.prompt_tokens,
      tokensOut: usage?.completion_tokens,
    });
  })().catch((err: unknown) => {
    log.warn({ err: String(err), connector: brain.connector }, 'completions passthrough: usage stream tap failed');
  });
}

/** Extract `usage` from one `data: {...}` SSE line, or `undefined` when this line carries none. */
function parseSseUsageLine(line: string): OpenAiCompatibleUsage | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]' || payload.length === 0) return undefined;
  try {
    return (JSON.parse(payload) as { usage?: OpenAiCompatibleUsage }).usage;
  } catch {
    return undefined;
  }
}
