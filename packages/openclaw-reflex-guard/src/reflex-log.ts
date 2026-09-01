/**
 * Layer 2 reflex log (issue #1252: "Every warranted turn logs to
 * `memory/reflex-log.jsonl`; `reaction` backfilled from Ryan's 👍/👎.").
 * `reaction` backfill (feedback capture) is deferred — see PR body — so
 * every record here is written with `reaction: null` until that follow-up
 * lands.
 */
import { appendJsonlLine } from "./jsonl-writer.js";
import type { ReflexLogEntry } from "./reflex-types.js";

export const DEFAULT_REFLEX_LOG_PATH = "reflex-guard/reflex-log.jsonl";

export interface ReflexLogger {
  record(entry: Omit<ReflexLogEntry, "ts">): void;
}

/**
 * Fire-and-forget JSONL writer. Mirrors `src/audit-log.ts`'s contract: a
 * logging failure must never block or fail the turn.
 */
export function createReflexLogger(
  path: string = DEFAULT_REFLEX_LOG_PATH,
  writeLine: (filePath: string, record: unknown) => Promise<void> = appendJsonlLine,
): ReflexLogger {
  return {
    record(entry) {
      const line: ReflexLogEntry = { ts: new Date().toISOString(), ...entry };
      void writeLine(path, line).catch((err: unknown) => {
        console.error(
          "[reflex-guard] failed to write reflex-log entry:",
          err instanceof Error ? err.message : String(err),
        );
      });
    },
  };
}
