import { describe, it, expect } from 'vitest';
import { toCoreMessages, toToolChoice, toToolSet, translateRequest } from '../message-mapping';
import type { OpenAIChatMessage, OpenAIToolDefinition } from '../types';

describe('toCoreMessages', () => {
  it('maps system and user messages straight through', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi there' },
    ];
    expect(toCoreMessages(messages)).toEqual([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi there' },
    ]);
  });

  it('maps a plain assistant message (no tool calls) to a string-content message', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'assistant', content: 'sure thing' }];
    expect(toCoreMessages(messages)).toEqual([{ role: 'assistant', content: 'sure thing' }]);
  });

  it('maps an assistant message with tool_calls to text + tool-call parts', () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"nyc"}' } },
        ],
      },
    ];
    const [result] = toCoreMessages(messages);
    expect(result).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', args: { city: 'nyc' } },
      ],
    });
  });

  it('omits the text part when an assistant tool-call message has no content', () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
      },
    ];
    const [result] = toCoreMessages(messages);
    expect(result).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'noop', args: {} }],
    });
  });

  it('falls back to an empty object when tool_call arguments are not valid JSON', () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: 'not-json' } }],
      },
    ];
    const [result] = toCoreMessages(messages);
    const content = (result as { content: Array<{ args: unknown }> }).content;
    expect(content[0].args).toEqual({});
  });

  it('maps a tool-result message, recovering the tool name from the preceding assistant tool_calls', () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
      },
      { role: 'tool', content: '{"temp":72}', tool_call_id: 'call_1' },
    ];
    const [, toolMessage] = toCoreMessages(messages);
    expect(toolMessage).toEqual({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'get_weather', result: '{"temp":72}' }],
    });
  });

  it('falls back to unknown_tool when no matching tool_call name can be found', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'tool', content: 'result', tool_call_id: 'call_missing' }];
    const [toolMessage] = toCoreMessages(messages);
    const content = (toolMessage as { content: Array<{ toolName: string }> }).content;
    expect(content[0].toolName).toBe('unknown_tool');
  });
});

describe('toToolSet', () => {
  it('returns undefined for no tools', () => {
    expect(toToolSet(undefined)).toBeUndefined();
    expect(toToolSet([])).toBeUndefined();
  });

  it('builds a ToolSet keyed by function name, with no execute function (so calls are forwarded, not run)', () => {
    const tools: OpenAIToolDefinition[] = [
      { type: 'function', function: { name: 'get_weather', description: 'gets weather', parameters: { type: 'object', properties: {} } } },
    ];
    const toolSet = toToolSet(tools);
    expect(toolSet).toBeDefined();
    expect(Object.keys(toolSet!)).toEqual(['get_weather']);
    expect(toolSet!['get_weather'].description).toBe('gets weather');
    expect(toolSet!['get_weather'].execute).toBeUndefined();
  });

  it('skips a non-function tool entry', () => {
    const tools = [{ type: 'not-a-function', function: { name: 'x' } }] as unknown as OpenAIToolDefinition[];
    expect(toToolSet(tools)).toBeUndefined();
  });
});

describe('toToolChoice', () => {
  const tools = toToolSet([{ type: 'function', function: { name: 'get_weather' } }]);

  it('returns undefined when there is no choice or no tools', () => {
    expect(toToolChoice(undefined, tools)).toBeUndefined();
    expect(toToolChoice('auto', undefined)).toBeUndefined();
  });

  it('passes through literal modes', () => {
    expect(toToolChoice('auto', tools)).toBe('auto');
    expect(toToolChoice('none', tools)).toBe('none');
    expect(toToolChoice('required', tools)).toBe('required');
  });

  it('maps a named function choice to the AI SDK tool-choice shape', () => {
    expect(toToolChoice({ type: 'function', function: { name: 'get_weather' } }, tools)).toEqual({
      type: 'tool',
      toolName: 'get_weather',
    });
  });
});

describe('translateRequest', () => {
  it('bundles messages, tools, and toolChoice from a request body', () => {
    const translated = translateRequest({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'noop' } }],
      tool_choice: 'auto',
    });
    expect(translated.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(Object.keys(translated.tools!)).toEqual(['noop']);
    expect(translated.toolChoice).toBe('auto');
  });
});
