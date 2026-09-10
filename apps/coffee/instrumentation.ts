/**
 * Runs once when this Next.js server instance boots, before any request is
 * handled (stable since Next 15 — no `experimental.instrumentationHook`
 * flag needed).
 *
 * Registers @imajin/logger's DB-backed request/app log sink (registry.logs)
 * so that `withLogger`/`createLogger` calls throughout this app persist to
 * Postgres when `ENABLE_REQUEST_LOG` / `LOG_DB_TRANSPORT` / `ENABLE_APP_LOG`
 * are set. Core `@imajin/logger` has no `@imajin/db` dependency (#2143) —
 * this import is what opts an app that already depends on `@imajin/db` in
 * to that behavior.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@imajin/logger/db');
  }
}
