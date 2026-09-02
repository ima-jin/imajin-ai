import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { mapAssistantLine, mapJsonlLines } from '../src/mapper';

const FIXTURE_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/sample-session.jsonl');

function readFixtureLines(): unknown[] {
  return readFileSync(FIXTURE_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { __malformed: line };
      }
    });
}

describe('mapAssistantLine', () => {
  it('maps a well-formed assistant line to a usage row', () => {
    const row = mapAssistantLine({
      type: 'assistant',
      uuid: 'line-5',
      timestamp: '2026-01-01T00:00:10.000Z',
      message: {
        id: 'msg_01BBB',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 540, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 88 },
      },
    });

    expect(row).toEqual({
      source: 'adapter:claude-code',
      resource: 'model:anthropic/claude-sonnet-4-5-20250929',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      tokens_in: 540,
      tokens_out: 88,
      external_id: 'msg_01BBB',
      ts: '2026-01-01T00:00:10.000Z',
    });
  });

  it('folds cache_read_input_tokens into tokens_in', () => {
    const row = mapAssistantLine({
      type: 'assistant',
      uuid: 'line-2',
      timestamp: '2026-01-01T00:00:05.000Z',
      message: {
        id: 'msg_01AAA',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 120, cache_read_input_tokens: 300, output_tokens: 1 },
      },
    });

    expect(row?.tokens_in).toBe(420);
  });

  it('falls back to the line uuid when message.id is absent', () => {
    const row = mapAssistantLine({
      type: 'assistant',
      uuid: 'line-fallback',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 1, output_tokens: 1 } },
    });

    expect(row?.external_id).toBe('line-fallback');
  });

  it('ignores non-assistant lines', () => {
    expect(mapAssistantLine({ type: 'user', message: { content: 'hi' } })).toBeUndefined();
    expect(mapAssistantLine({ type: 'system', subtype: 'turn_duration' })).toBeUndefined();
    expect(mapAssistantLine({ type: 'summary', summary: 'x' })).toBeUndefined();
  });

  it('ignores an assistant line with no usage object', () => {
    expect(mapAssistantLine({ type: 'assistant', message: { model: 'claude-sonnet-4-5-20250929' } })).toBeUndefined();
  });

  it('ignores the synthetic/local-turn sentinel model', () => {
    const row = mapAssistantLine({
      type: 'assistant',
      uuid: 'line-8',
      timestamp: '2026-01-01T00:01:00.000Z',
      message: { id: 'msg_01CCC', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
    });

    expect(row).toBeUndefined();
  });

  it('ignores a line missing a timestamp', () => {
    const row = mapAssistantLine({
      type: 'assistant',
      message: { id: 'msg_x', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 1, output_tokens: 1 } },
    });

    expect(row).toBeUndefined();
  });

  it('returns undefined for non-object input', () => {
    expect(mapAssistantLine(null)).toBeUndefined();
    expect(mapAssistantLine('not an object')).toBeUndefined();
    expect(mapAssistantLine(42)).toBeUndefined();
  });

  it('defaults missing token fields to zero rather than throwing', () => {
    const row = mapAssistantLine({
      type: 'assistant',
      uuid: 'line-x',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { id: 'msg_x', model: 'claude-sonnet-4-5-20250929', usage: {} },
    });

    expect(row).toMatchObject({ tokens_in: 0, tokens_out: 0 });
  });
});

describe('mapJsonlLines — fixture session', () => {
  const lines = readFixtureLines();

  it('maps only the assistant lines that carry real, non-synthetic usage', () => {
    const rows = mapJsonlLines(lines);
    // msg_01AAA (2 lines collapsed to 1) + msg_01BBB = 2 rows; the
    // synthetic-model line and the malformed line are both excluded.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.external_id).sort()).toEqual(['msg_01AAA', 'msg_01BBB']);
  });

  it('collapses same-message.id lines to the last-seen (most complete) usage', () => {
    const rows = mapJsonlLines(lines);
    const collapsed = rows.find((r) => r.external_id === 'msg_01AAA');

    // The two msg_01AAA lines share usage input/cache figures but the second
    // carries the more complete output_tokens (45 vs the first line's 1) —
    // collapsing must keep that second line, not the first.
    expect(collapsed).toMatchObject({ tokens_out: 45, tokens_in: 420 });
  });

  it('is idempotent: mapping the same lines twice yields the same rows', () => {
    expect(mapJsonlLines(lines)).toEqual(mapJsonlLines(lines));
  });

  it('produces rows that satisfy the ingest resource-shape contract', () => {
    for (const row of mapJsonlLines(lines)) {
      expect(row.resource).toMatch(/^model:anthropic\/\S+$/);
      expect(row.source).toBe('adapter:claude-code');
    }
  });
});
