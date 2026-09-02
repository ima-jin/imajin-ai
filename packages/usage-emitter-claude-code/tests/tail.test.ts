import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tailNewLines, type TailState } from '../src/tail';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-emitter-claude-code-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function emptyState(): TailState {
  return { offsets: {} };
}

describe('tailNewLines', () => {
  it('returns no lines and no offsets for a directory with no jsonl files', () => {
    const result = tailNewLines(dir, emptyState());
    expect(result.rawLines).toEqual([]);
    expect(result.state.offsets).toEqual({});
  });

  it('returns nothing for a directory that does not exist', () => {
    const result = tailNewLines(join(dir, 'does-not-exist'), emptyState());
    expect(result.rawLines).toEqual([]);
  });

  it('reads every complete line on the first pass', () => {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '{"type":"assistant","a":1}\n{"type":"user","a":2}\n');

    const result = tailNewLines(dir, emptyState());

    expect(result.rawLines).toEqual([{ type: 'assistant', a: 1 }, { type: 'user', a: 2 }]);
    expect(result.state.offsets[file]).toBe(Buffer.byteLength('{"type":"assistant","a":1}\n{"type":"user","a":2}\n'));
  });

  it('only reads NEW lines appended since the last recorded offset', () => {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '{"type":"assistant","a":1}\n');
    const first = tailNewLines(dir, emptyState());

    appendFileSync(file, '{"type":"assistant","a":2}\n');
    const second = tailNewLines(dir, first.state);

    expect(second.rawLines).toEqual([{ type: 'assistant', a: 2 }]);
  });

  it('holds back a trailing line with no newline yet, for the next run', () => {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '{"type":"assistant","a":1}\n{"type":"assistant","a":2}');

    const first = tailNewLines(dir, emptyState());
    expect(first.rawLines).toEqual([{ type: 'assistant', a: 1 }]);

    appendFileSync(file, '\n');
    const second = tailNewLines(dir, first.state);
    expect(second.rawLines).toEqual([{ type: 'assistant', a: 2 }]);
  });

  it('skips a malformed complete line without failing the whole tail', () => {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '{"type":"assistant","a":1}\nnot json\n{"type":"assistant","a":2}\n');

    const result = tailNewLines(dir, emptyState());

    expect(result.rawLines).toEqual([{ type: 'assistant', a: 1 }, { type: 'assistant', a: 2 }]);
  });

  it('walks nested project directories recursively', () => {
    const nested = join(dir, 'project-a', 'subdir');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'session.jsonl'), '{"type":"assistant","a":1}\n');

    const result = tailNewLines(dir, emptyState());

    expect(result.rawLines).toEqual([{ type: 'assistant', a: 1 }]);
  });

  it('ignores non-.jsonl files', () => {
    writeFileSync(join(dir, 'notes.txt'), '{"type":"assistant","a":1}\n');

    const result = tailNewLines(dir, emptyState());

    expect(result.rawLines).toEqual([]);
  });

  it('resyncs forward when a file has shrunk below the recorded offset (rotation/truncation)', () => {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '{"type":"assistant","a":1}\n{"type":"assistant","a":2}\n');
    const first = tailNewLines(dir, emptyState());

    writeFileSync(file, '{"type":"assistant","a":3}\n');
    const second = tailNewLines(dir, first.state);

    // Does not re-read/replay old content past the new (smaller) size; the
    // offset resyncs to the current size so only genuinely new bytes appear.
    expect(second.rawLines).toEqual([]);
    expect(second.state.offsets[file]).toBe(Buffer.byteLength('{"type":"assistant","a":3}\n'));
  });
});
