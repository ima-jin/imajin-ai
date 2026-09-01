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
import type { LanguageModelV1 } from '@imajin/llm';
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

const log = createLogger('kernel:inference:completions:anthropic');

/** Matches the OpenAI-compatible adapter's upstream deadline. */
const UPSTREAM_TIMEOUT_MS = 120_000;

export async function forwardAnthropic(
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

type Model = LanguageModelV1;
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
      ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    });

    log.info(
      {
        connector: brain.connector,
        model: brain.modelId,
        sessionId: meta.sessionId ?? null,
        turnId: meta.turnId ?? null,
        finishReason: result.finishReason,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      },
      'completions passthrough: anthropic completion finished',
    );

    const completion = buildChatCompletion(brain.modelId, result);
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
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
    model,
    messages,
    tools,
    toolChoice,
    toolCallStreaming: true,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    onFinish: ({ finishReason, usage }) => {
      log.info(
        {
          connector: brain.connector,
          model: brain.modelId,
          sessionId: meta.sessionId ?? null,
          turnId: meta.turnId ?? null,
          finishReason,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        },
        'completions passthrough: anthropic stream finished',
      );
    },
  });

  const builder = new OpenAIStreamChunkBuilder(brain.modelId);
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const part of result.fullStream) {
          const bytes = encodePart(builder, part);
          if (bytes) controller.enqueue(bytes);
        }
      } catch (err) {
        // A mid-stream network/timeout failure — the 200 + headers already
        // went out, so the only graceful option left is a final error frame
        // rather than an unhandled rejection that hangs the connection.
        log.warn({ connector: brain.connector, err: describeError(err) }, 'completions passthrough: anthropic stream failed');
        controller.enqueue(sseEncode({ error: { message: 'upstream_error', type: 'upstream_error' } }));
      } finally {
        controller.enqueue(SSE_DONE_FRAME);
        controller.close();
      }
    },
  });

  return new Response(readable, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}

function encodePart(builder: OpenAIStreamChunkBuilder, part: TextStreamPart<ToolSet>): Uint8Array | undefined {
  switch (part.type) {
    case 'text-delta':
      return sseEncode(builder.textDelta(part.textDelta));
    case 'tool-call-streaming-start':
      return sseEncode(builder.toolCallStart(part.toolCallId, part.toolName));
    case 'tool-call-delta':
      return sseEncode(builder.toolCallArgsDelta(part.toolCallId, part.argsTextDelta));
    case 'tool-call': {
      const chunk = builder.toolCallComplete(part.toolCallId, part.toolName, part.args);
      return chunk ? sseEncode(chunk) : undefined;
    }
    case 'finish':
      return sseEncode(builder.finish(part.finishReason, part.usage));
    case 'error':
      return sseEncode({ error: { message: describeError(part.error), type: 'upstream_error' } });
    default:
      return undefined;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
