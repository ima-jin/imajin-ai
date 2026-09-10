/**
 * DB-backed request/app log sink for `@imajin/logger`.
 *
 * This is the ONLY module in `@imajin/logger` that imports `@imajin/db`
 * (Postgres + drizzle). It is published as the `@imajin/logger/db` subpath
 * export precisely so that consumers who don't want Postgres in their
 * dependency closure (e.g. `@imajin/auth`, and anything that only imports
 * `createLogger`/`withLogger` from the package root) never pull it in — see
 * #2143.
 *
 * Consumers that DO want DB-persisted logs (request logs via
 * `ENABLE_REQUEST_LOG=true`, app logs via `LOG_DB_TRANSPORT` /
 * `ENABLE_APP_LOG=true`) register this sink once, as early as possible in
 * the process, with a side-effect import:
 *
 *   import '@imajin/logger/db';
 *
 * In a Next.js app this belongs in `instrumentation.ts`'s `register()`
 * (stable since Next 15, runs once at server boot before any request):
 *
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === 'nodejs') {
 *       await import('@imajin/logger/db');
 *     }
 *   }
 */
import { getClient } from '@imajin/db';
import { nanoid } from 'nanoid';
import { randomUUID } from 'node:crypto';
import { registerLogSink } from './sink';
import type { LogSink, RequestLogEntry, AppLogEntry } from './sink';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // opportunistic, at most once per hour per process
const REQUEST_LOG_RETENTION_DAYS = 30;

// Opportunistic cleanup timestamps — tracked separately per source so a burst
// of one kind of log doesn't starve the other's cleanup.
let lastRequestCleanupAt = 0;
let lastAppCleanupAt = 0;

function runRequestLogCleanup(): void {
  const now = Date.now();
  if (now - lastRequestCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastRequestCleanupAt = now;
  const sql = getClient();
  Promise.resolve(sql`SELECT registry.cleanup_old_logs(${REQUEST_LOG_RETENTION_DAYS})`).catch(() => {
    // Never block or surface errors from the log sink
  });
}

function runAppLogCleanup(): void {
  const now = Date.now();
  if (now - lastAppCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastAppCleanupAt = now;
  const sql = getClient();
  Promise.resolve(sql`SELECT registry.cleanup_old_logs()`).catch(() => {
    // Never block or surface errors from the log sink
  });
}

function writeRequestLog(entry: RequestLogEntry): void {
  const sql = getClient();
  const id = `req_${nanoid(16)}`;
  let level: string;
  if (entry.status >= 500) level = 'error';
  else if (entry.status >= 400) level = 'warn';
  else level = 'info';
  const message = entry.errorMessage || `${entry.method} ${entry.path} → ${entry.status}`;
  Promise.resolve(
    sql`
      INSERT INTO registry.logs
        (id, source, service, level, message, method, path, status, duration_ms, correlation_id, ip, error_message, created_at)
      VALUES
        (${id}, 'request', ${entry.service}, ${level}, ${message}, ${entry.method}, ${entry.path}, ${entry.status},
         ${entry.durationMs}, ${entry.correlationId}, ${entry.ip},
         ${entry.errorMessage ?? null}, now())
    `
  )
    .then(() => {
      runRequestLogCleanup();
    })
    .catch(() => {
      // Silently ignore — never block or surface errors from the log sink
    });
}

function writeAppLog(entry: AppLogEntry): void {
  const sql = getClient();
  const id = `log_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  Promise.resolve(
    sql`
      INSERT INTO registry.logs
        (id, source, service, level, message, correlation_id, did, method, path, error_message, metadata, created_at)
      VALUES
        (${id}, 'app', ${entry.service}, ${entry.level}, ${entry.message},
         ${entry.correlationId ?? null}, ${entry.did ?? null},
         ${entry.method ?? null}, ${entry.path ?? null},
         ${entry.errorMessage ?? null},
         ${entry.metadata ? JSON.stringify(entry.metadata) : null}::jsonb,
         now())
    `
  )
    .then(() => {
      runAppLogCleanup();
    })
    .catch(() => {
      // Never block or surface errors from the log sink
    });
}

export const dbSink: LogSink = {
  writeRequestLog,
  writeAppLog,
};

registerLogSink(dbSink);
