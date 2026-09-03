import { describe, expect, it } from 'vitest';
import { mapAssistantLine, mapJsonlLines } from '../../src/usage-emitter/mapper.js';

const assistantLine = {
  type: 'assistant',
  uuid: 'line-uuid-1',
  timestamp: '2026-09-02T12:00:00.000Z',
  message: {
    id: 'msg-abc',
    model: 'claude-sonnet-4-5',
    usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 40 },
  },
};

describe('mapAssistantLine', () => {
  it('maps a well-formed assistant line to a usage.incurred row with source harness:nanoclaw', () => {
    const row = mapAssistantLine(assistantLine);
    expect(row).toEqual({
      source: 'harness:nanoclaw',
      resource: 'model:anthropic/claude-sonnet-4-5',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      tokens_in: 120,
      tokens_out: 40,
      external_id: 'msg-abc',
      ts: '2026-09-02T12:00:00.000Z',
    });
  });

  it('ignores non-assistant lines', () => {
    expect(mapAssistantLine({ type: 'user' })).toBeUndefined();
  });

  it('ignores assistant lines with no usage object', () => {
    expect(mapAssistantLine({ type: 'assistant', message: { model: 'x' } })).toBeUndefined();
  });

  it('excludes synthetic-model turns', () => {
    expect(
      mapAssistantLine({
        ...assistantLine,
        message: { ...assistantLine.message, model: '<synthetic>' },
      }),
    ).toBeUndefined();
  });

  it('falls back to the line uuid when message.id is absent', () => {
    const row = mapAssistantLine({
      ...assistantLine,
      message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    expect(row?.external_id).toBe('line-uuid-1');
  });

  it('drops a line with no timestamp', () => {
    const { timestamp, ...rest } = assistantLine;
    void timestamp;
    expect(mapAssistantLine(rest)).toBeUndefined();
  });
});

describe('mapJsonlLines', () => {
  it('collapses lines sharing one message.id, keeping the last seen', () => {
    const first = { ...assistantLine, message: { ...assistantLine.message, usage: { input_tokens: 10, output_tokens: 1 } } };
    const second = { ...assistantLine, message: { ...assistantLine.message, usage: { input_tokens: 10, output_tokens: 40 } } };
    const rows = mapJsonlLines([first, second]);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens_out).toBe(40);
  });

  it('skips lines with no billable usage', () => {
    expect(mapJsonlLines([{ type: 'user' }, { type: 'system' }])).toEqual([]);
  });
});
