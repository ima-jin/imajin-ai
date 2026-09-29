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
 * Also fetches the shared `ATTESTATION_INTERNAL_API_KEY` from the vault at
 * boot (#2353, `bootstrapInternalApiKey` in `@imajin/auth`) using this
 * service's own `EVENTS_VAULT_BOOTSTRAP_DID` / `_PRIVATE_KEY` identity. It fails
 * closed: if the key can't be resolved, one ERROR names the DID, purpose and
 * operator grant command, and internal posts to the kernel throw instead of
 * sending an empty header.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@imajin/logger/db');

    const { bootstrapInternalApiKey } = await import('@imajin/auth');
    await bootstrapInternalApiKey('events');
  }
}
