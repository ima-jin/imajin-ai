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
 *
 * It then LOADS the vault (#2412), logging `vault: loaded N entries from
 * <path>`. A configured VAULT_PATH whose file is missing throws here, so the
 * kernel refuses to boot instead of serving an empty vault behind a green
 * /health (unless VAULT_ALLOW_BOOTSTRAP=1 explicitly requests a first-run
 * bootstrap).
 *
 * Also registers the kernel's own `ATTESTATION_INTERNAL_API_KEY` resolver with
 * `@imajin/auth` (#2353). packages/auth no longer reads that key from
 * `process.env`; userspace services fetch it from the vault at boot, and the
 * kernel — which owns the secret — resolves it from its own vault
 * (`getInternalSecret`), keeping the deprecated env value as the same
 * fallback `requireInternalApiKey` still honors until #2353 step 4 deletes it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@imajin/logger/db');

    const { loadVaultAtBoot } = await import('@/src/lib/vault/vault-repository');
    await loadVaultAtBoot();

    // The vault/db modules are imported lazily, on first use, so register()
    // itself stays free of database side effects at boot.
    const { setInternalApiKeyResolver } = await import('@imajin/auth');
    setInternalApiKeyResolver(async () => {
      const { getInternalSecret } = await import('@/src/lib/vault/internal-secret');
      const { ATTESTATION_INTERNAL_API_KEY_PURPOSE } = await import('@/src/lib/auth/require-internal-api-key');
      const secret = await getInternalSecret(ATTESTATION_INTERNAL_API_KEY_PURPOSE).catch(() => null);
      return secret || process.env.ATTESTATION_INTERNAL_API_KEY;
    });
  }
}
