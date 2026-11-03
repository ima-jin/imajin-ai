/**
 * Anthropic completions adapter (#1925).
 *
 * Anthropic does not speak the OpenAI wire format, so unlike the
 * OpenAI-compatible adapter this one cannot forward bytes untouched. Instead
 * it reuses brain.ts's EXISTING Anthropic connector exactly as the issue asks
 * ("Anthropic reuses its existing brain.ts adapter"): `getModel('anthropic', ...)`
 * from `@imajin/llm`, driven through the AI SDK's `generateText`/`streamText` —
 * the same two functions the rest of the kernel's inference pipeline already
 * calls (`policy.ts`, the presence stream route). `message-mapping.ts` and
 * `response-mapping.ts` do the OpenAI ⇄ AI SDK translation on the way in and
 * out; this module just wires brain → AI SDK → OpenAI shape together.
 */
import { generateText, streamText } from 'ai';
import type { CoreMessage, TextStreamPart, ToolChoice, ToolSet } from 'ai';
import { getModel } from '@imajin/llm';
import type { LanguageModel } from '@imajin/llm';
import { createLogger } from '@imajin/logger';
import type { ResolvedBrain } from '../brain';
import { translateRequest } from './message-mapping';
import {
  OpenAIStreamChunkBuilder,
  SSE_DONE_FRAME,
  buildChatCompletion,
  sseEncode,
} from './response-mapping';
import { UpstreamTimeoutError } from './errors';
import type { ChatCompletionsRequestBody, CompletionsRequestMetadata } from './types';
import { recordInferenceUsage } from '../usage-ledger';
import { inferenceError, inferenceStream, inferenceText } from '../org-inference-safety';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';

const log = createLogger('kernel:inference:completions:anthropic');

/** Matches the OpenAI-compatible adapter's upstream deadline. */
const UPSTREAM_TIMEOUT_MS = 120_000;

export async function forwardAnthropic(
  brain: ResolvedBrain,
  body: ChatCompletionsRequestBody,
  meta: CompletionsRequestMetadata,
): Promise<Response> {
  try {
    return await forwardAnthropicInternal(brain, body, meta);
  } catch (err) {
    if (brain.orgUsage) throw new ExternalMcpError(502, 'Organization inference upstream unavailable');
    throw err;
  }
}

async function forwardAnthropicInternal(
  brain: ResolvedBrain,
  body: ChatCompletionsRequestBody,
  meta: CompletionsRequestMetadata,
): Promise<Response> {
  const { messages, tools, toolChoice } = translateRequest(body);
  const model = getModel(brain.provider, brain.modelId, {
    apiKey: brain.apiKey,
    ...(brain.baseURL === undefined ? {} : { baseURL: brain.baseURL }),
  });
  const stream = Boolean(body.stream);

  log.info(
    {
      connector: brain.connector,
      model: brain.modelId,
      sessionId: meta.sessionId ?? null,
      turnId: meta.turnId ?? null,
      stream,
      toolCount: tools ? Object.keys(tools).length : 0,
    },
    'completions passthrough: forwarding to Anthropic via the AI SDK',
  );

  return stream
    ? streamAnthropic(brain, model, messages, tools, toolChoice, body, meta)
    : generateAnthropic(brain, model, messages, tools, toolChoice, body, meta);
}

type Model = LanguageModel;
type CoreMessages = CoreMessage[];
type Tools = ToolSet | undefined;
type ToolChoiceArg = ToolChoice<ToolSet> | undefined;

/** Rethrows an aborted/timed-out AI SDK call as the shared `UpstreamTimeoutError`. */
function rethrowAsTimeout(connector: string, err: unknown): never {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    throw new UpstreamTimeoutError(connector);
  }
  throw err;
}

async function generateAnthropic(
  brain: ResolvedBrain,
  model: Model,
  messages: CoreMessages,
  tools: Tools,
  toolChoice: ToolChoiceArg,
  body: ChatCompletionsRequestBody,
  meta: CompletionsRequestMetadata,
): Promise<Response> {
  try {
    const result = await generateText({
      model,
      messages,
      tools,
      toolChoice,
      // 1 retry is enough to absorb a transient blip, matching policy.ts's
      // reasoning: more just amplifies a genuine rate limit (#1764).
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    });

    log.info(
      {
        connector: brain.connector,
        model: brain.modelId,
        sessionId: meta.sessionId ?? null,
        turnId: meta.turnId ?? null,
        finishReason: result.finishReason,
        promptTokens: result.usage.inputTokens,
        completionTokens: result.usage.outputTokens,
      },
      'completions passthrough: anthropic completion finished',
    );

    await recordInferenceUsage({
      sessionId: meta.sessionId,
      turnId: meta.turnId,
      warpRunId: meta.warpRunId,
      principalDid: brain.orgUsage?.memberDid ?? brain.credentialDid,
      ...(brain.orgUsage ? { metadata: { orgDid: brain.orgUsage.orgDid, grantId: brain.orgUsage.grantId, connectionId: brain.orgUsage.connectionId } } : {}),
      agentDid: brain.actorDid ?? meta.agentDid,
      provider: brain.connector,
      model: brain.modelId,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      // #2204: the AI SDK surfaces the provider's own response id here.
      externalId: result.response?.id === undefined ? undefined : inferenceText(brain, result.response.id),
    });

    const completion = buildChatCompletion(brain.modelId, result);
    return new Response(inferenceText(brain, JSON.stringify(completion)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (brain.orgUsage) throw new ExternalMcpError(502, 'Organization inference upstream unavailable');
    rethrowAsTimeout(brain.connector, err);
  }
}

function streamAnthropic(
  brain: ResolvedBrain,
  model: Model,
  messages: CoreMessages,
  tools: Tools,
  toolChoice: ToolChoiceArg,
  body: ChatCompletionsRequestBody,
  meta: CompletionsRequestMetadata,
): Response {
  const result = streamText({
    ...(brain.orgUsage ? { onError: () => { /* Provider diagnostics may contain the org key; the stream emits a safe error. */ } } : {}),
    model,
    messages,
    tools,
    toolChoice,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    onFinish: ({ finishReason, usage, response }) => {
      log.info(
        {
          connector: brain.connector,
          model: brain.modelId,
          sessionId: meta.sessionId ?? null,
          turnId: meta.turnId ?? null,
          finishReason,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
        },
        'completions passthrough: anthropic stream finished',
      );

      recordInferenceUsage({
        sessionId: meta.sessionId,
        turnId: meta.turnId,
        warpRunId: meta.warpRunId,
        principalDid: brain.orgUsage?.memberDid ?? brain.credentialDid,
        ...(brain.orgUsage ? { metadata: { orgDid: brain.orgUsage.orgDid, grantId: brain.orgUsage.grantId, connectionId: brain.orgUsage.connectionId } } : {}),
        agentDid: brain.actorDid ?? meta.agentDid,
        provider: brain.connector,
        model: brain.modelId,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        // #2204: same provider response id the non-streaming path reads off `result.response.id`.
        externalId: response?.id === undefined ? undefined : inferenceText(brain, response.id),
      }).catch((err: unknown) => {
        log.error({ err: inferenceError(brain, err), connector: brain.connector }, 'completions passthrough: usage ledger write failed');
      });
    },
  });

  const builder = new OpenAIStreamChunkBuilder(brain.modelId);
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const part of result.fullStream) {
          const bytes = encodePart(builder, part, brain);
          if (bytes) controller.enqueue(bytes);
        }
      } catch (err) {
        // A mid-stream network/timeout failure — the 200 + headers already
        // went out, so the only graceful option left is a final error frame
        // rather than an unhandled rejection that hangs the connection.
        log.warn({ connector: brain.connector, err: inferenceError(brain, err) }, 'completions passthrough: anthropic stream failed');
        controller.enqueue(sseEncode({ error: { message: 'upstream_error', type: 'upstream_error' } }));
      } finally {
        controller.enqueue(SSE_DONE_FRAME);
        controller.close();
      }
    },
  });

  return new Response(inferenceStream(brain, readable), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}

function encodePart(builder: OpenAIStreamChunkBuilder, part: TextStreamPart<ToolSet>, brain: ResolvedBrain): Uint8Array | undefined {
  switch (part.type) {
    case 'text-delta':
      return sseEncode(builder.textDelta(part.text));
    case 'tool-input-start':
      return sseEncode(builder.toolCallStart(part.id, part.toolName));
    case 'tool-input-delta':
      return sseEncode(builder.toolCallArgsDelta(part.id, part.delta));
    case 'tool-call': {
      const chunk = builder.toolCallComplete(part.toolCallId, part.toolName, part.input);
      return chunk ? sseEncode(chunk) : undefined;
    }
    case 'finish':
      return sseEncode(builder.finish(part.finishReason, part.totalUsage));
    case 'error':
      return sseEncode({ error: { message: inferenceError(brain, part.error), type: 'upstream_error' } });
    default:
      return undefined;
  }
}

