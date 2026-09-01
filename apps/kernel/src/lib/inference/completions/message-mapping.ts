/**
 * OpenAI request shape → AI SDK translation (#1925).
 *
 * Only the Anthropic adapter needs this: Anthropic does not speak the OpenAI
 * wire format, so its brain connector (`brain.ts`) is driven through the AI
 * SDK's `generateText`/`streamText` instead of a raw fetch, and those
 * functions want `CoreMessage[]` + a `ToolSet`, not OpenAI's `messages`/`tools`
 * shape. The OpenAI-compatible adapter needs none of this — it forwards the
 * client's body verbatim.
 *
 * Tool calls are declared WITHOUT an `execute` function on purpose: per the
 * AI SDK docs, a tool with no `execute` is never invoked automatically, so
 * the model's tool call comes back on `result.toolCalls` / a `tool-call`
 * stream part for the passthrough to hand back to the caller — the caller
 * (the agent on the other end of the passthrough) is the one that actually
 * runs the tool and answers with a `role: 'tool'` message on the next turn.
 * The kernel does not execute callers' tools; it only forwards the
 * conversation about them.
 */
import { jsonSchema, tool as aiTool } from 'ai';
import type { CoreMessage, TextPart, Tool, ToolCallPart, ToolChoice, ToolSet } from 'ai';
import type {
  ChatCompletionsRequestBody,
  OpenAIChatMessage,
  OpenAIToolChoice,
  OpenAIToolDefinition,
} from './types';

type JsonSchema7 = Parameters<typeof jsonSchema>[0];

/** Convert the OpenAI-shaped `messages` array into AI SDK `CoreMessage[]`. */
export function toCoreMessages(messages: OpenAIChatMessage[]): CoreMessage[] {
  const toolNameByCallId = collectToolNamesByCallId(messages);
  return messages.map((msg) => toCoreMessage(msg, toolNameByCallId));
}

function collectToolNamesByCallId(messages: OpenAIChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    for (const call of msg.tool_calls ?? []) {
      map.set(call.id, call.function.name);
    }
  }
  return map;
}

function toCoreMessage(msg: OpenAIChatMessage, toolNameByCallId: Map<string, string>): CoreMessage {
  if (msg.role === 'assistant') return toAssistantMessage(msg);
  if (msg.role === 'tool') return toToolMessage(msg, toolNameByCallId);
  if (msg.role === 'system') return { role: 'system', content: msg.content ?? '' };
  // 'user', and anything unrecognized — fail open as a user turn rather than
  // silently dropping the message's content.
  return { role: 'user', content: msg.content ?? '' };
}

function toAssistantMessage(msg: OpenAIChatMessage): CoreMessage {
  if (!msg.tool_calls || msg.tool_calls.length === 0) {
    return { role: 'assistant', content: msg.content ?? '' };
  }
  const parts: Array<TextPart | ToolCallPart> = [];
  if (msg.content) parts.push({ type: 'text', text: msg.content });
  for (const call of msg.tool_calls) {
    parts.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.function.name,
      args: parseJsonArgs(call.function.arguments),
    });
  }
  return { role: 'assistant', content: parts };
}

function toToolMessage(msg: OpenAIChatMessage, toolNameByCallId: Map<string, string>): CoreMessage {
  const toolCallId = msg.tool_call_id ?? '';
  // OpenAI tool-result messages don't always carry `name`; fall back to the
  // name recorded from the assistant's own tool_calls earlier in the same
  // request. Anthropic's tool_result block keys on toolCallId, not name, so
  // this is a best-effort label rather than a correctness requirement.
  const toolName = msg.name ?? toolNameByCallId.get(toolCallId) ?? 'unknown_tool';
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, result: msg.content ?? '' }],
  };
}

function parseJsonArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Convert OpenAI `tools` (function definitions) into an AI SDK `ToolSet`. */
export function toToolSet(tools: OpenAIToolDefinition[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;

  const toolSet: ToolSet = {};
  for (const t of tools) {
    if (t.type !== 'function' || !t.function.name) continue;
    const schema = (t.function.parameters ?? { type: 'object', properties: {} }) as JsonSchema7;
    toolSet[t.function.name] = aiTool({
      description: t.function.description,
      parameters: jsonSchema(schema),
    }) as Tool;
  }
  return Object.keys(toolSet).length > 0 ? toolSet : undefined;
}

/** Convert OpenAI `tool_choice` into the AI SDK's `ToolChoice`. */
export function toToolChoice(
  choice: OpenAIToolChoice | undefined,
  tools: ToolSet | undefined,
): ToolChoice<ToolSet> | undefined {
  if (!choice || !tools) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  return { type: 'tool', toolName: choice.function.name };
}

/** Bundle of everything `generateText`/`streamText` need, derived from the request body. */
export interface TranslatedRequest {
  messages: CoreMessage[];
  tools: ToolSet | undefined;
  toolChoice: ToolChoice<ToolSet> | undefined;
}

export function translateRequest(body: ChatCompletionsRequestBody): TranslatedRequest {
  const tools = toToolSet(body.tools);
  return {
    messages: toCoreMessages(body.messages),
    tools,
    toolChoice: toToolChoice(body.tool_choice, tools),
  };
}
