/**
 * Session JSONL tailer (#1151) — Node builtins only, no new dependencies.
 *
 * Walks `~/.claude/projects/**\/*.jsonl`, reads only the bytes appended since
 * the last recorded offset per file, and parses complete lines. State
 * (per-file byte offsets) is a small local JSON file so a re-run after a
 * crash or a cron restart doesn't re-read the whole history — the
 * `external_id` dedupe key on the kernel side (migrations/0121) is the
 * second, durable line of defense if it ever does.
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface TailState {
  /** Absolute file path → byte offset already consumed. */
  offsets: Record<string, number>;
}

export function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

export function defaultStateFilePath(): string {
  return join(homedir(), '.claude', 'usage-emitter-claude-code-state.json');
}

export function loadState(stateFilePath: string): TailState {
  if (!existsSync(stateFilePath)) return { offsets: {} };
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath, 'utf8')) as Partial<TailState>;
    return { offsets: parsed.offsets ?? {} };
  } catch {
    // A corrupt state file re-tails from scratch — the dedupe key on the
    // kernel side makes that a no-op for anything already ingested.
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

/**
 * Read every new, COMPLETE line appended to every `.jsonl` file under
 * `projectsDir` since `previousState`, returning the parsed lines and the
 * state to persist afterward.
 *
 * A trailing line with no newline yet (Claude Code mid-write) is held back
 * for the next run rather than parsed as truncated JSON. A malformed
 * complete line is skipped, not fatal — a scanner reading a live,
 * append-only file should never crash on one bad line.
 */
export function tailNewLines(projectsDir: string, previousState: TailState): TailResult {
  const offsets = { ...previousState.offsets };
  const rawLines: unknown[] = [];

  for (const file of walkJsonlFiles(projectsDir)) {
    const size = statSync(file).size;
    const previousOffset = offsets[file] ?? 0;
    if (size <= previousOffset) {
      // File shrank below our offset (rotated/truncated) — resync forward
      // rather than attempt to read negative-length new content.
      offsets[file] = size;
      continue;
    }

    const fd = openSync(file, 'r');
    try {
      const length = size - previousOffset;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, previousOffset);
      const text = buffer.toString('utf8');

      // split() on a trailing '\n' yields one extra empty string at the end;
      // dropping the last element either discards that empty string (text
      // ended cleanly) or holds back a genuinely partial line (text did not)
      // — both are the right thing to do.
      const completeLines = text.split('\n').slice(0, -1);
      let consumedBytes = 0;
      for (const line of completeLines) {
        consumedBytes += Buffer.byteLength(line, 'utf8') + 1; // +1 for the newline
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
