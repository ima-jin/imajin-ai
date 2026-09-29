/**
 * Process-wide vault repository + non-secret status (#2412).
 *
 * Lives apart from ./index.ts (which pulls in the DB and bus singletons) so
 * `instrumentation.ts#register()` and `/api/health` can load and inspect the
 * vault without importing the whole vault service.
 *
 * Nothing here runs at module import time: `next build` imports route modules
 * with NODE_ENV=production on a machine that legitimately has no VAULT_PATH,
 * so resolving/loading must stay lazy (see ./vault-path.ts).
 */
import { FileVaultRepository, VaultFileMissingError } from '@imajin/vault-core';
import { createLogger } from '@imajin/logger';
import {
  VAULT_BOOTSTRAP_ENV,
  isVaultBootstrapAllowed,
  isVaultPathConfigured,
  resolveVaultPath,
} from './vault-path';

const log = createLogger('kernel');

// Process-lifetime cache — constructed once, on first real vault operation.
let cachedRepository: FileVaultRepository | undefined;

/**
 * Lazily construct the on-disk vault repository.
 *
 * A configured `VAULT_PATH` is strict: a missing file throws on load unless
 * `VAULT_ALLOW_BOOTSTRAP` is set. With no `VAULT_PATH` (non-production dev
 * convenience) the historical default path bootstraps as before.
 */
export function getVaultRepository(): FileVaultRepository {
  if (cachedRepository === undefined) {
    const vaultPath = resolveVaultPath();
    cachedRepository = new FileVaultRepository({
      vaultPath,
      allowBootstrap: isVaultBootstrapAllowed() || !isVaultPathConfigured(),
    });
    log.info({ vaultPath }, 'Vault service initialised');
  }
  return cachedRepository;
}

/**
 * Load the vault once at server boot and log `vault: loaded N entries from <path>`.
 *
 * Throws when `VAULT_PATH` names a file that does not exist (and bootstrap was
 * not explicitly requested) so the kernel refuses to start instead of serving
 * a permanently empty vault behind a green /health.
 */
export async function loadVaultAtBoot(): Promise<void> {
  const repository = getVaultRepository();
  try {
    await repository.load();
  } catch (error) {
    if (error instanceof VaultFileMissingError) {
      log.error(
        { vaultPath: error.vaultPath },
        `vault: configured VAULT_PATH file is missing — refusing to boot. Restore it, fix VAULT_PATH, or set ${VAULT_BOOTSTRAP_ENV}=1 for a first-run bootstrap`,
      );
    }
    throw error;
  }

  const status = repository.getStatus();
  if (status.bootstrapped) {
    log.warn(
      { vaultPath: status.path },
      `vault: no file at configured path — bootstrapping an empty vault (${VAULT_BOOTSTRAP_ENV} is set); unset it once the file exists`,
    );
  }
  log.info(`vault: loaded ${status.entryCount ?? 0} entries from ${status.path}`);
}

export interface VaultHealth {
  /**
   * `ok`     — loaded, entries present.
   * `empty`  — loaded, zero entries (a red flag on prod; #2412).
   * `error`  — the vault could not be loaded (e.g. configured file missing).
   */
  status: 'ok' | 'empty' | 'error';
  path: string | null;
  entryCount: number | null;
  lastLoadedAt: string | null;
  bootstrapped: boolean;
  /** Stable machine code only — never a message that could carry vault content. */
  error?: string;
}

/**
 * Non-secret vault status for health endpoints: path, entry count and last
 * load time only. Never field names or values.
 *
 * Loads the vault if this module instance has not yet done so (Next may
 * bundle instrumentation and route handlers separately, so the boot-time
 * load is not guaranteed to be visible here).
 */
export async function getVaultHealth(): Promise<VaultHealth> {
  let repository: FileVaultRepository;
  try {
    repository = getVaultRepository();
  } catch {
    return { status: 'error', path: null, entryCount: null, lastLoadedAt: null, bootstrapped: false, error: 'VAULT_PATH_UNRESOLVED' };
  }

  if (repository.getStatus().lastLoadedAt === null) {
    try {
      await repository.load();
    } catch (error) {
      const code = error instanceof VaultFileMissingError ? error.code : 'VAULT_LOAD_FAILED';
      return { ...repository.getStatus(), status: 'error', error: code };
    }
  }

  const status = repository.getStatus();
  return { ...status, status: status.entryCount === 0 ? 'empty' : 'ok' };
}

/** Reset the cache — only for use in tests. */
export function _resetVaultRepositoryForTests(): void {
  cachedRepository = undefined;
}
