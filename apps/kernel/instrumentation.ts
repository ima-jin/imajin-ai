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
 *
 * Also resolves VAULT_PATH (#2357) right here at real server boot: unlike
 * `next build` (which imports route modules, including the vault, with
 * NODE_ENV=production while collecting page data on a build machine that
 * legitimately has no VAULT_PATH set), `register()` runs only when an actual
 * server instance starts — the correct, safe place for "the kernel refuses
 * to start in production without VAULT_PATH" to actually happen, rather than
 * deferring the failure to whatever request first happens to touch the vault.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@imajin/logger/db');

    const { resolveVaultPath } = await import('@/src/lib/vault/vault-path');
    resolveVaultPath();
  }
}
