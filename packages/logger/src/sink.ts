/**
 * Pluggable DB-backed log sink registry.
 *
 * Core `@imajin/logger` never imports `@imajin/db` — that's the seam #2143
 * exists to close. `withLogger` (middleware.ts) and the pino adapter
 * (adapters/pino.ts) call into whatever sink is registered here, and do
 * nothing when none is. `@imajin/logger/db` is the only module that ever
 * calls `registerLogSink`, and it does so as an import side effect —
 * consumers that want DB-persisted logs add a single
 * `import '@imajin/logger/db'` (see that module's docblock for where).
 */

export interface RequestLogEntry {
  service: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  correlationId: string;
  ip: string;
  errorMessage?: string;
}

export interface AppLogEntry {
  service: string;
  level: string;
  message: string;
  correlationId?: string;
  did?: string;
  method?: string;
  path?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface LogSink {
  writeRequestLog?(entry: RequestLogEntry): void;
  writeAppLog?(entry: AppLogEntry): void;
}

let activeSink: LogSink | null = null;

/**
 * Registers the active log sink. Last writer wins — there is only ever one
 * process-wide sink, matching the previous dynamic-import-on-first-use
 * behavior (a single `@imajin/db` connection pool per process).
 */
export function registerLogSink(sink: LogSink): void {
  activeSink = sink;
}

export function getLogSink(): LogSink | null {
  return activeSink;
}

/**
 * Test-only helper to reset sink state between test files/cases.
 */
export function resetLogSink(): void {
  activeSink = null;
}
