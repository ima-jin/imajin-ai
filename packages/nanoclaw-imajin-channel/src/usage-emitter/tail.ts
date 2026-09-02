/**
 * Session JSONL tailer (imajin-ai#1932/#1151). Node builtins only.
 *
 * Same CONTRACT as `packages/usage-emitter-claude-code/src/tail.ts` — read
 * only the bytes appended to each `.jsonl` file since the last recorded
 * offset, hold back an unterminated trailing line, skip malformed complete
 * lines — but implemented independently (that package only exports its
 * top-level CLI entry, not this helper, so it can't be imported here).
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

/** Depth-first, iterative (no recursion) directory walk collecting every `.jsonl` file path under `root`. */
function findJsonlFiles(root: string): string[] {
  const found: string[] = [];
  const pending: string[] = existsSync(root) ? [root] : [];

  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push(entryPath);
      }
    }
  }

  return found;
}

/** Read the newly-appended byte range of one file and parse its complete lines. Returns the new offset alongside whatever parsed. */
function readNewLines(filePath: string, previousOffset: number): { offset: number; parsed: unknown[] } {
  const size = statSync(filePath).size;
  if (size <= previousOffset) {
    // Rotated/truncated below our offset — resync forward, nothing new to read.
    return { offset: size, parsed: [] };
  }

  const fd = openSync(filePath, 'r');
  let text: string;
  try {
    const chunk = Buffer.alloc(size - previousOffset);
    readSync(fd, chunk, 0, chunk.length, previousOffset);
    text = chunk.toString('utf8');
  } finally {
    closeSync(fd);
  }

  // The final array element after split('\n') is either '' (text ended on a
  // newline) or a partial line (text ended mid-write) — pop() discards the
  // right thing either way and its length tells us how many bytes NOT to
  // count as consumed.
  const segments = text.split('\n');
  const heldBack = segments.pop() ?? '';
  const parsed: unknown[] = [];
  for (const line of segments) {
    if (line.trim().length === 0) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // A malformed complete line is skipped, not fatal — see module header.
    }
  }

  const consumedBytes = Buffer.byteLength(text, 'utf8') - Buffer.byteLength(heldBack, 'utf8');
  return { offset: previousOffset + consumedBytes, parsed };
}

export interface TailResult {
  rawLines: unknown[];
  state: TailState;
}

export function tailNewLines(projectsDir: string, previousState: TailState): TailResult {
  const nextOffsets: Record<string, number> = { ...previousState.offsets };
  const rawLines: unknown[] = [];

  for (const filePath of findJsonlFiles(projectsDir)) {
    const { offset, parsed } = readNewLines(filePath, nextOffsets[filePath] ?? 0);
    nextOffsets[filePath] = offset;
    rawLines.push(...parsed);
  }

  return { rawLines, state: { offsets: nextOffsets } };
}
