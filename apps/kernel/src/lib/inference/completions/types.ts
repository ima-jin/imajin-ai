/**
 * OpenAI chat-completions wire shapes (#1925).
 *
 * Deliberately minimal: only the fields the passthrough actually reads or
 * writes are typed. `ChatCompletionsRequestBody` extends an index signature so
 * fields neither adapter understands (e.g. `top_p`, `presence_penalty`) still
 * flow through the OpenAI-compatible raw-fetch adapter untouched — the whole
 * point of that adapter is that it does NOT need to understand the full
 * OpenAI surface, only forward it.
 */

export type OpenAIRole = 'system' | 'user' | 'assistant' | 'tool';

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded arguments, exactly as OpenAI's wire format carries them. */
    arguments: string;
  };
}

export interface OpenAIChatMessage {
  role: OpenAIRole;
  content: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  /** Present on `role: 'tool'` messages — the call this message answers. */
  tool_call_id?: string;
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    /** Raw JSON Schema, as OpenAI's tool-calling API defines it. */
    parameters?: Record<string, unknown>;
  };
}

/** Mirrors OpenAI's `tool_choice`: a literal mode, or pinning one named tool. */
export type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ChatCompletionsRequestBody {
  model?: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  // Any other OpenAI-shaped field the client sends. Read only by the raw
  // passthrough adapter, which forwards the whole body verbatim.
  [key: string]: unknown;
}

export interface OpenAIChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: OpenAIChatCompletionChunkDelta;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Per-turn metering seam (#1922 target architecture component 3, built out in
 * #1923). OpenClaw passes these as `X-Session-Id` / `X-Turn-Id` request
 * headers; this route only threads them through logging today so the actual
 * ledger write in #1923 is additive rather than a request-path rework.
 */
export interface CompletionsRequestMetadata {
  sessionId?: string;
  turnId?: string;
}
