/**
 * Session JSONL tailer (imajin-ai#1932/#1151). Node builtins only.
 *
 * Same algorithm as `packages/usage-emitter-claude-code/src/tail.ts` (that
 * package only exports its top-level CLI entry, not this helper, so it is
 * re-implemented here rather than imported): walks every `.jsonl` file under
 * a directory, reads only the bytes appended since the last recorded
 * offset, and parses complete lines. A trailing line with no newline yet is
 * held back for the next run; a malformed complete line is skipped, never
 * fatal.
 *
 * Pointed at a NanoClaw agent group's `.claude-shared/projects/` directory
 * (the host-side bind mount of `/home/node/.claude` — see
 * `container-runner.ts`'s `buildMounts`) instead of `~/.claude/projects`.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TailState {
  offsets: Record<string, number>;
}

export function loadState(stateFilePath: string): TailState {
  if (!existsSync(stateFilePath)) return { offsets: {} };
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath, 'utf8')) as Partial<TailState>;
    return { offsets: parsed.offsets ?? {} };
  } catch {
    return { offsets: {} };
  }
}

export function saveState(stateFilePath: string, state: TailState): void {
  writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
}

function walkJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

export interface TailResult {
  rawLines: unknown[];
  state: TailState;
}

export function tailNewLines(projectsDir: string, previousState: TailState): TailResult {
  const offsets = { ...previousState.offsets };
  const rawLines: unknown[] = [];

  for (const file of walkJsonlFiles(projectsDir)) {
    const size = statSync(file).size;
    const previousOffset = offsets[file] ?? 0;
    if (size <= previousOffset) {
      offsets[file] = size;
      continue;
    }

    const fd = openSync(file, 'r');
    try {
      const length = size - previousOffset;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, previousOffset);
      const text = buffer.toString('utf8');

      const completeLines = text.split('\n').slice(0, -1);
      let consumedBytes = 0;
      for (const line of completeLines) {
        consumedBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (!line.trim()) continue;
        try {
          rawLines.push(JSON.parse(line));
        } catch {
          // Skip malformed lines — see module header.
        }
      }

      offsets[file] = previousOffset + consumedBytes;
    } finally {
      closeSync(fd);
    }
  }

  return { rawLines, state: { offsets } };
}
