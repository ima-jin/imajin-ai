import { describe, it, expect } from 'vitest';
import {
  OpenAIStreamChunkBuilder,
  SSE_DONE_FRAME,
  buildChatCompletion,
  mapFinishReason,
  sseEncode,
} from '../response-mapping';

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

describe('mapFinishReason', () => {
  it('maps known AI SDK finish reasons to OpenAI codes', () => {
    expect(mapFinishReason('tool-calls')).toBe('tool_calls');
    expect(mapFinishReason('length')).toBe('length');
    expect(mapFinishReason('content-filter')).toBe('content_filter');
    expect(mapFinishReason('stop')).toBe('stop');
  });

  it('collapses any unrecognized reason to stop', () => {
    expect(mapFinishReason('other')).toBe('stop');
    expect(mapFinishReason('error')).toBe('stop');
  });
});

describe('buildChatCompletion', () => {
  it('builds a chat.completion with text content and no tool_calls', () => {
    const completion = buildChatCompletion('claude-sonnet-4-20250514', {
      text: 'hello there',
      toolCalls: [],
      finishReason: 'stop',
      usage: USAGE,
    });

    expect(completion.object).toBe('chat.completion');
    expect(completion.model).toBe('claude-sonnet-4-20250514');
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0]).toMatchObject({
      index: 0,
      message: { role: 'assistant', content: 'hello there' },
      finish_reason: 'stop',
    });
    expect(completion.choices[0].message.tool_calls).toBeUndefined();
    expect(completion.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('builds a chat.completion with tool_calls and null content when text is empty', () => {
    const completion = buildChatCompletion('claude-sonnet-4-20250514', {
      text: '',
      toolCalls: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', args: { city: 'nyc' } }],
      finishReason: 'tool-calls',
      usage: USAGE,
    });

    expect(completion.choices[0].message.content).toBeNull();
    expect(completion.choices[0].message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"nyc"}' } },
    ]);
    expect(completion.choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('OpenAIStreamChunkBuilder', () => {
  it('sends role only on the first text delta', () => {
    const builder = new OpenAIStreamChunkBuilder('grok-4');
    const first = builder.textDelta('Hel');
    const second = builder.textDelta('lo');
    expect(first.choices[0].delta).toEqual({ role: 'assistant', content: 'Hel' });
    expect(second.choices[0].delta).toEqual({ content: 'lo' });
    expect(first.id).toBe(second.id);
    expect(first.object).toBe('chat.completion.chunk');
  });

  it('assigns stable, incrementing indexes per toolCallId across start/delta calls', () => {
    const builder = new OpenAIStreamChunkBuilder('grok-4');
    const start1 = builder.toolCallStart('call_1', 'get_weather');
    const start2 = builder.toolCallStart('call_2', 'get_time');
    const delta1 = builder.toolCallArgsDelta('call_1', '{"city":');

    expect(start1.choices[0].delta.tool_calls?.[0]).toMatchObject({ index: 0, id: 'call_1' });
    expect(start2.choices[0].delta.tool_calls?.[0]).toMatchObject({ index: 1, id: 'call_2' });
    expect(delta1.choices[0].delta.tool_calls?.[0]).toMatchObject({ index: 0, function: { arguments: '{"city":' } });
  });

  it('emits a complete tool call only when it was not already streamed incrementally', () => {
    const builder = new OpenAIStreamChunkBuilder('grok-4');
    builder.toolCallStart('call_1', 'get_weather');

    expect(builder.toolCallComplete('call_1', 'get_weather', {})).toBeUndefined();
    const complete = builder.toolCallComplete('call_2', 'get_time', { tz: 'UTC' });
    expect(complete?.choices[0].delta.tool_calls?.[0]).toMatchObject({
      index: 1,
      id: 'call_2',
      function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
    });
  });

  it('includes usage on the finish chunk only when usage is provided', () => {
    const builder = new OpenAIStreamChunkBuilder('grok-4');
    const withoutUsage = builder.finish('stop');
    expect(withoutUsage.usage).toBeUndefined();
    expect(withoutUsage.choices[0].finish_reason).toBe('stop');

    const withUsage = builder.finish('tool-calls', USAGE);
    expect(withUsage.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(withUsage.choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('sseEncode / SSE_DONE_FRAME', () => {
  it('encodes a JSON payload as a data: frame', () => {
    const bytes = sseEncode({ foo: 'bar' });
    expect(new TextDecoder().decode(bytes)).toBe('data: {"foo":"bar"}\n\n');
  });

  it('SSE_DONE_FRAME is the literal [DONE] frame', () => {
    expect(new TextDecoder().decode(SSE_DONE_FRAME)).toBe('data: [DONE]\n\n');
  });
});
