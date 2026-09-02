import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadState, saveState, tailNewLines } from '../../src/usage-emitter/tail.js';

describe('tailNewLines', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanoclaw-usage-tail-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads only newly-appended complete lines across runs', () => {
    const sub = join(dir, 'project-a');
    mkdirSync(sub, { recursive: true });
    const file = join(sub, 'session.jsonl');
    writeFileSync(file, '{"a":1}\n{"a":2}\n');

    const first = tailNewLines(dir, { offsets: {} });
    expect(first.rawLines).toEqual([{ a: 1 }, { a: 2 }]);

    appendFileSync(file, '{"a":3}\n');
    const second = tailNewLines(dir, first.state);
    expect(second.rawLines).toEqual([{ a: 3 }]);
  });

  it('holds back a trailing line with no newline yet', () => {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '{"a":1}\n{"a":2}'); // no trailing newline on the second line

    const result = tailNewLines(dir, { offsets: {} });
    expect(result.rawLines).toEqual([{ a: 1 }]);

    appendFileSync(file, '\n');
    const second = tailNewLines(dir, result.state);
    expect(second.rawLines).toEqual([{ a: 2 }]);
  });

  it('skips malformed lines without throwing', () => {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '{"a":1}\nnot json\n{"a":2}\n');
    const result = tailNewLines(dir, { offsets: {} });
    expect(result.rawLines).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('returns no lines and no crash for a nonexistent directory', () => {
    const result = tailNewLines(join(dir, 'does-not-exist'), { offsets: {} });
    expect(result.rawLines).toEqual([]);
  });

  it('round-trips state through save/load', () => {
    const stateFile = join(dir, 'state.json');
    const state = { offsets: { '/some/path.jsonl': 42 } };
    saveState(stateFile, state);
    expect(loadState(stateFile)).toEqual(state);
  });

  it('loadState returns empty offsets for a missing or corrupt file', () => {
    expect(loadState(join(dir, 'missing.json'))).toEqual({ offsets: {} });
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, 'not json');
    expect(loadState(corrupt)).toEqual({ offsets: {} });
  });
});
