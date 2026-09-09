/**
 * Characterization tests for the stream-handling helpers extracted from
 * PresenceChat's sendMessage (#2119, cognitive complexity S3776).
 * sendMessage itself had no prior tests; these pin the parsing/dispatch/
 * response-validation behavior that used to live inline so the extraction
 * is provably value-equivalent.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseStreamLine,
  dispatchStreamEvent,
  validateStreamResponse,
  consumeEventStream,
  type Message,
  type ToolEvent,
} from '../PresenceChat';

describe('parseStreamLine', () => {
  it('returns null for a blank line', () => {
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('   ')).toBeNull();
  });

  it('returns null for a malformed line instead of throwing', () => {
    expect(parseStreamLine('{not json')).toBeNull();
  });

  it('parses a well-formed NDJSON line', () => {
    expect(parseStreamLine('{"type":"text","text":"hi"}')).toEqual({ type: 'text', text: 'hi' });
  });
});

describe('dispatchStreamEvent', () => {
  function setup() {
    const messages: Message[] = [{ id: 'assistant-1', role: 'assistant', content: '' }];
    const toolEvents: ToolEvent[] = [];
    const setMessages = vi.fn((updater: (prev: Message[]) => Message[]) => {
      messages.splice(0, messages.length, ...updater(messages));
    });
    const setToolEvents = vi.fn((updater: (prev: ToolEvent[]) => ToolEvent[]) => {
      toolEvents.splice(0, toolEvents.length, ...updater(toolEvents));
    });
    const setError = vi.fn();
    return { messages, toolEvents, setMessages, setToolEvents, setError };
  }

  it('appends text to the matching assistant message', () => {
    const { messages, setMessages, setToolEvents, setError } = setup();
    dispatchStreamEvent({ type: 'text', text: 'Hello' }, 'assistant-1', setMessages, setToolEvents, setError);
    expect(messages[0].content).toBe('Hello');
  });

  it('leaves other messages untouched', () => {
    const state = setup();
    state.messages.unshift({ id: 'user-1', role: 'user', content: 'hi' });
    dispatchStreamEvent({ type: 'text', text: '!' }, 'assistant-1', state.setMessages, state.setToolEvents, state.setError);
    expect(state.messages).toEqual([
      { id: 'user-1', role: 'user', content: 'hi' },
      { id: 'assistant-1', role: 'assistant', content: '!' },
    ]);
  });

  it('records a tool_call event', () => {
    const { toolEvents, setMessages, setToolEvents, setError } = setup();
    dispatchStreamEvent({ type: 'tool_call', name: 'search', args: { q: 'x' } }, 'assistant-1', setMessages, setToolEvents, setError);
    expect(toolEvents).toEqual([
      { type: 'tool_call', name: 'search', data: { q: 'x' }, timestamp: expect.any(Number) },
    ]);
  });

  it('records a tool_result event', () => {
    const { toolEvents, setMessages, setToolEvents, setError } = setup();
    dispatchStreamEvent({ type: 'tool_result', name: 'search', result: { ok: true } }, 'assistant-1', setMessages, setToolEvents, setError);
    expect(toolEvents).toEqual([
      { type: 'tool_result', name: 'search', data: { ok: true }, timestamp: expect.any(Number) },
    ]);
  });

  it('sets the error message on an error event', () => {
    const { setMessages, setToolEvents, setError } = setup();
    dispatchStreamEvent({ type: 'error', message: 'boom' }, 'assistant-1', setMessages, setToolEvents, setError);
    expect(setError).toHaveBeenCalledWith('boom');
  });

  it('ignores unknown event types', () => {
    const { messages, toolEvents, setMessages, setToolEvents, setError } = setup();
    dispatchStreamEvent({ type: 'ping' }, 'assistant-1', setMessages, setToolEvents, setError);
    expect(messages[0].content).toBe('');
    expect(toolEvents).toEqual([]);
    expect(setError).not.toHaveBeenCalled();
  });
});

describe('validateStreamResponse', () => {
  it('resolves for an ok response with a body', async () => {
    const res = { ok: true, body: {} } as unknown as Response;
    await expect(validateStreamResponse(res)).resolves.toBeUndefined();
  });

  it('throws the response error message when not ok', async () => {
    const res = {
      ok: false,
      status: 500,
      json: async () => ({ error: 'server exploded' }),
    } as unknown as Response;
    await expect(validateStreamResponse(res)).rejects.toThrow('server exploded');
  });

  it('falls back to a status-based message when the error body cannot be parsed', async () => {
    const res = {
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response;
    await expect(validateStreamResponse(res)).rejects.toThrow('Request failed (502)');
  });

  it('throws when the response has no body', async () => {
    const res = { ok: true, body: null } as unknown as Response;
    await expect(validateStreamResponse(res)).rejects.toThrow('No response body');
  });
});

describe('consumeEventStream', () => {
  function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i++]));
        } else {
          controller.close();
        }
      },
    });
  }

  it('parses complete NDJSON lines and invokes onEvent for each', async () => {
    const body = streamFromChunks(['{"type":"text","text":"a"}\n{"type":"text","text":"b"}\n']);
    const events: unknown[] = [];
    await consumeEventStream(body, (e) => events.push(e));
    expect(events).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('buffers a line split across chunks until it is complete', async () => {
    const body = streamFromChunks(['{"type":"text",', '"text":"a"}\n']);
    const events: unknown[] = [];
    await consumeEventStream(body, (e) => events.push(e));
    expect(events).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('skips blank and malformed lines without invoking onEvent', async () => {
    const body = streamFromChunks(['\n{not json}\n{"type":"text","text":"ok"}\n']);
    const events: unknown[] = [];
    await consumeEventStream(body, (e) => events.push(e));
    expect(events).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
