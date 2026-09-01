/**
 * Layer 1 audit log (issue #1252: "audit-log each trip (term id, surface,
 * action taken) to a configurable JSONL path"). Deliberately redacted: a
 * record never carries the matched text or the sealed pattern itself — only
 * which term id tripped, on which surface, and what action was taken. The
 * audit log must never itself become a leak vector for the very terms it is
 * protecting.
 */
import { appendJsonlLine } from "./jsonl-writer.js";

export interface AuditLogEntry {
  ts: string;
  termId: string;
  surface: string;
  action: "block" | "flag";
  sessionKey?: string;
}

export interface AuditLogger {
  record(entry: Omit<AuditLogEntry, "ts">): void;
}

/**
 * Fire-and-forget JSONL audit logger. `record` never throws and never
 * returns a promise for the caller to await — a logging failure must never
 * block or fail the guard's own block/flag decision, which has already been
 * made by the time `record` is called.
 */
export function createAuditLogger(
  path: string,
  writeLine: (filePath: string, record: unknown) => Promise<void> = appendJsonlLine,
): AuditLogger {
  return {
    record(entry) {
      const line: AuditLogEntry = { ts: new Date().toISOString(), ...entry };
      void writeLine(path, line).catch((err: unknown) => {
        console.error(
          `[reflex-guard] failed to write audit log entry (term=${entry.termId}, surface=${entry.surface}):`,
          err instanceof Error ? err.message : String(err),
        );
      });
    },
  };
}
