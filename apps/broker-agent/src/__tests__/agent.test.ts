/**
 * routeMessage tool-use loop (#2570). Tool calls within one turn must run one
 * at a time and in order, results must keep that order, and a failing tool must
 * be reported back to Claude as an `Error:` result rather than aborting the turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { create, executeTool } = vi.hoisted(() => ({
  create: vi.fn(),
  executeTool: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));

vi.mock('../tools.js', () => ({
  BROKER_TOOLS: [],
  executeTool,
}));

import { routeMessage } from '../agent';
import type { KernelClient } from '../client';

const kernel = {} as KernelClient;

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

describe('routeMessage', () => {
  beforeEach(() => {
    create.mockReset();
    executeTool.mockReset();
  });

  it('returns the text block when Claude calls no tools', async () => {
    create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello' }] });
    await expect(routeMessage('did:imajin:u', 'hi', kernel)).resolves.toBe('Hello');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('runs tool calls one at a time, in order, and feeds results back in that order', async () => {
    const events: string[] = [];
    executeTool.mockImplementation(async (name: string) => {
      events.push(`start-${name}`);
      await new Promise((resolve) => setTimeout(resolve, name === 'first' ? 20 : 1));
      events.push(`end-${name}`);
      return `result-${name}`;
    });
    create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'thinking' }, toolUse('t1', 'first'), toolUse('t2', 'second', { a: 1 })],
      })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done it' }] });

    await expect(routeMessage('did:imajin:u', 'do things', kernel)).resolves.toBe('Done it');

    expect(events).toEqual(['start-first', 'end-first', 'start-second', 'end-second']);
    expect(executeTool).toHaveBeenNthCalledWith(2, 'second', { a: 1 }, 'did:imajin:u', kernel);
    const secondCall = create.mock.calls[1][0];
    expect(secondCall.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'result-first' },
        { type: 'tool_result', tool_use_id: 't2', content: 'result-second' },
      ],
    });
  });

  it('reports a failing tool as an Error result and still runs the next tool', async () => {
    executeTool.mockRejectedValueOnce(new Error('kernel down')).mockResolvedValueOnce('ok');
    create
      .mockResolvedValueOnce({ stop_reason: 'tool_use', content: [toolUse('t1', 'a'), toolUse('t2', 'b')] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [] });

    await expect(routeMessage('did:imajin:u', 'x', kernel)).resolves.toBe('Done.');

    expect(create.mock.calls[1][0].messages.at(-1).content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'Error: Error: kernel down' },
      { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
    ]);
  });

  it('gives up after five tool-use turns', async () => {
    executeTool.mockResolvedValue('ok');
    create.mockResolvedValue({ stop_reason: 'tool_use', content: [toolUse('t', 'loop')] });

    await expect(routeMessage('did:imajin:u', 'x', kernel)).resolves.toBe(
      'I ran into an issue processing that. Please try again.',
    );
    expect(create).toHaveBeenCalledTimes(5);
  });
});
