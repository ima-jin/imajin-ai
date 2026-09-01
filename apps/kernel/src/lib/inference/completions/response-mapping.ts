/**
 * AI SDK result → OpenAI response shape translation (#1925).
 *
 * The mirror of `message-mapping.ts`: once `generateText`/`streamText` have
 * run against the Anthropic model, their result needs to come back out as an
 * OpenAI `chat.completion` (non-streaming) or a `chat.completion.chunk` SSE
 * stream (streaming) — the shape every OpenAI-compatible client, including
 * the one calling this passthrough, already knows how to parse.
 */
import { generateId } from 'ai';
import type { LanguageModelUsage, ToolCallUnion, ToolSet } from 'ai';
import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionChunkDelta,
  OpenAIToolCall,
} from './types';

type OpenAIFinishReason = OpenAIChatCompletion['choices'][number]['finish_reason'];

/**
 * AI SDK's `FinishReason` is provider-agnostic and slightly wider than
 * OpenAI's; anything not explicitly named collapses to `'stop'` rather than
 * inventing a code OpenAI clients won't recognize.
 */
export function mapFinishReason(reason: string): OpenAIFinishReason {
  switch (reason) {
    case 'tool-calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function toOpenAIUsage(usage: LanguageModelUsage): OpenAIChatCompletion['usage'] {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}

export interface GenerateTextOutcome {
  text: string;
  toolCalls: ReadonlyArray<ToolCallUnion<ToolSet>>;
  finishReason: string;
  usage: LanguageModelUsage;
}

/** Build a non-streaming `chat.completion` from a resolved `generateText` result. */
export function buildChatCompletion(modelId: string, result: GenerateTextOutcome): OpenAIChatCompletion {
  const toolCalls: OpenAIToolCall[] = result.toolCalls.map((tc) => ({
    id: tc.toolCallId,
    type: 'function',
    function: { name: tc.toolName, arguments: JSON.stringify(tc.args) },
  }));

  return {
    id: `chatcmpl-${generateId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text.length > 0 ? result.text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapFinishReason(result.finishReason),
      },
    ],
    usage: toOpenAIUsage(result.usage),
  };
}

/**
 * Incrementally builds `chat.completion.chunk` SSE payloads for one response,
 * tracking the per-tool-call `index` OpenAI's streaming delta format requires
 * (the first mention of a tool call assigns it the next index; every later
 * delta for the same `toolCallId` reuses it).
 */
export class OpenAIStreamChunkBuilder {
  private readonly id = `chatcmpl-${generateId()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly toolCallIndex = new Map<string, number>();
  private nextToolIndex = 0;
  private sentRole = false;

  constructor(private readonly modelId: string) {}

  private chunk(delta: OpenAIChatCompletionChunkDelta, finishReason: OpenAIFinishReason | null = null): OpenAIChatCompletionChunk {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }

  private indexFor(toolCallId: string): number {
    let index = this.toolCallIndex.get(toolCallId);
    if (index === undefined) {
      index = this.nextToolIndex++;
      this.toolCallIndex.set(toolCallId, index);
    }
    return index;
  }

  textDelta(text: string): OpenAIChatCompletionChunk {
    const delta: OpenAIChatCompletionChunkDelta = { content: text };
    if (!this.sentRole) {
      delta.role = 'assistant';
      this.sentRole = true;
    }
    return this.chunk(delta);
  }

  toolCallStart(toolCallId: string, toolName: string): OpenAIChatCompletionChunk {
    const index = this.indexFor(toolCallId);
    return this.chunk({ tool_calls: [{ index, id: toolCallId, type: 'function', function: { name: toolName, arguments: '' } }] });
  }

  toolCallArgsDelta(toolCallId: string, argsTextDelta: string): OpenAIChatCompletionChunk {
    const index = this.indexFor(toolCallId);
    return this.chunk({ tool_calls: [{ index, function: { arguments: argsTextDelta } }] });
  }

  /**
   * Some providers emit a tool call as one complete event rather than a
   * start + delta sequence. Returns `undefined` when this id was already
   * streamed incrementally, so the caller does not double-emit it.
   */
  toolCallComplete(toolCallId: string, toolName: string, args: unknown): OpenAIChatCompletionChunk | undefined {
    if (this.toolCallIndex.has(toolCallId)) return undefined;
    const index = this.indexFor(toolCallId);
    return this.chunk({
      tool_calls: [{ index, id: toolCallId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
    });
  }

  finish(reason: string, usage?: LanguageModelUsage): OpenAIChatCompletionChunk {
    const chunk = this.chunk({}, mapFinishReason(reason));
    return usage ? { ...chunk, usage: toOpenAIUsage(usage) } : chunk;
  }
}

/** Encode one JSON payload as an SSE `data:` frame. */
export function sseEncode(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/** The terminal `[DONE]` frame OpenAI-compatible SSE streams end with. */
export const SSE_DONE_FRAME = new TextEncoder().encode('data: [DONE]\n\n');
