/**
 * Per-environment VAULT_PATH resolution (#2357).
 *
 * Incident: `FileVaultRepository` defaulted to `~/.imajin/vault.json` and
 * neither prod-jin nor dev-jin set a `VAULT_PATH` override, so both
 * environments read/wrote the SAME vault file — dev code could read and
 * re-seal prod-sealed material (owner GitHub OAuth tokens, connector config,
 * Warp API keys, ...). Postgres is already split per env (separate
 * DATABASE_URL per pm2 process); the vault must be too.
 *
 * This module is the single place that decides which on-disk file the
 * kernel's vault reads/writes. It is deliberately side-effect-free at import
 * time — see {@link resolveVaultPath}'s docblock for why the production
 * guard below must never run merely because this file was imported.
 */
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/** The historical single-vault default — now ONLY acceptable outside production. */
const DEFAULT_VAULT_PATH = path.join(os.homedir(), '.imajin', 'vault.json');

/**
 * Expand a leading `~` (or `~/...`) to the current user's home directory.
 *
 * pm2 ecosystem configs are version-controlled and cannot embed a concrete
 * home directory, so `deploy/ecosystem.{dev,prod}.config.js` set VAULT_PATH
 * to literal `~/.imajin/vault.{dev,prod}.json` strings. Node never expands
 * `~` itself (that's a shell convention), so without this a literal `~`
 * directory would be created relative to the process's cwd instead.
 */
function expandTilde(rawPath: string): string {
  if (rawPath === '~') {
    return os.homedir();
  }
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

// Process-lifetime cache, mirroring sealing.ts's derivation caches — resolved
// once per process, and only ever cached on a SUCCESSFUL resolution so a
// production process that started without VAULT_PATH can still recover if the
// operator sets it and retries (rather than being permanently wedged from one
// early failed read).
let cachedVaultPath: string | undefined;

/**
 * Resolve the on-disk path `FileVaultRepository` should read/write.
 *
 * Deliberately NOT called at module import time anywhere in this package.
 * `next build` imports apps/kernel's route modules with NODE_ENV=production
 * while collecting page data, on a build machine/CI runner that legitimately
 * has no VAULT_PATH set (see the identical AUTH_PRIVATE_KEY reasoning in
 * ./sealing.ts). Throwing here at import time would turn this runtime
 * guard into a build failure. Callers must only invoke this lazily, at the
 * point the vault repository is actually constructed for real use (see
 * `getRepository` in ./index.ts and `register()` in ../../instrumentation.ts,
 * which calls this eagerly at actual server boot — never at build).
 *
 * Behaviour:
 *   - VAULT_PATH set (after trimming and `~` expansion) — used as-is.
 *   - VAULT_PATH unset/empty AND NODE_ENV=production — throws. Falling back
 *     to the shared default in production is exactly the bug this fixes: a
 *     silent fallback here is indistinguishable from dev and prod quietly
 *     sharing one vault file again.
 *   - VAULT_PATH unset/empty, NOT production — logs a loud warning and
 *     returns the historical default (`~/.imajin/vault.json`), so a single
 *     local dev checkout keeps working without any required setup.
 */
export function resolveVaultPath(): string {
  if (cachedVaultPath !== undefined) {
    return cachedVaultPath;
  }

  const raw = process.env.VAULT_PATH?.trim();
  if (raw) {
    cachedVaultPath = expandTilde(raw);
    return cachedVaultPath;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'VAULT_PATH is required in production: refusing to fall back to the shared default vault file ' +
      `(${DEFAULT_VAULT_PATH}). Dev and prod must never read/write the same vault (#2357 — a dev process ` +
      'could otherwise read and re-seal prod-sealed material). Set VAULT_PATH to a per-environment path ' +
      "(e.g. ~/.imajin/vault.prod.json) in this process's environment.",
    );
  }

  log.warn(
    { fallbackPath: DEFAULT_VAULT_PATH },
    'VAULT_PATH is not set — falling back to the shared default vault file. This is fine for a single ' +
    'local dev checkout, but NEVER point two environments (e.g. dev and prod) at the same vault file (#2357).',
  );
  cachedVaultPath = DEFAULT_VAULT_PATH;
  return cachedVaultPath;
}

/** Reset the cache — only for use in tests. */
export function _resetVaultPathCacheForTests(): void {
  cachedVaultPath = undefined;
}
