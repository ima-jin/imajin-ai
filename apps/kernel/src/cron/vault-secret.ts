/**
 * Fetch-at-boot of the cron bearer secret for the `*-kernel-cron` scheduler
 * (#2550, under epic #2241 — the #2245 `ATTESTATION_INTERNAL_API_KEY` pattern).
 *
 * The secret is a vault-generated internal secret: nobody pastes it onto a
 * box and it is not in `.env.local`. The deploy's provisioning step
 * (`scripts/provision-service-bootstrap.mjs`) mints this scheduler's bootstrap
 * identity (`KERNEL_CRON_VAULT_BOOTSTRAP_DID` / `_PRIVATE_KEY`, the same
 * mechanism every userspace service uses) and grants it the `kernel.cron-secret`
 * purpose. Here the scheduler authenticates as that identity and fetches the
 * CURRENT active grant for the purpose with `loadFromVault`
 * (`resolveGrantByPurpose`), so rotation is revoke + re-grant with no file edit
 * on either side — the next scheduler boot picks the new value up.
 *
 * Guarantees:
 *   - Memory only: the value is returned to the caller and never written to
 *     disk, an env var, a log line, or an error message.
 *   - One deferred ack: `loadFromVault` never acks at fetch time. The returned
 *     {@link GrantAckHandle} is `used` by the runner on the first request the
 *     kernel actually accepts (see `runner.ts`), and `discarded` automatically
 *     if the process exits without using it.
 *   - Fails closed, pointing at the vault: a missing grant (or an unreachable
 *     vault after the retry window) throws an error that names the vault and the
 *     provisioning step — never `.env.local`.
 *
 * The vault is the kernel itself, which may still be booting when pm2 starts
 * this process on a deploy, so the fetch retries for a bounded window before
 * giving up.
 *
 * Must stay free of Next.js / kernel-alias imports: the scheduler runs under
 * plain `node --import tsx`. `@imajin/auth` is imported lazily so tests (and
 * the config-error paths) do not load it.
 */
import type { GrantAckHandle, LoadFromVaultParams, VaultCredentials } from '@imajin/auth';
import type { CronLogLine } from './runner';
import { CRON_SECRET_PURPOSE } from './secret-purpose';

export const BOOTSTRAP_DID_ENV = 'KERNEL_CRON_VAULT_BOOTSTRAP_DID';
export const BOOTSTRAP_PRIVATE_KEY_ENV = 'KERNEL_CRON_VAULT_BOOTSTRAP_PRIVATE_KEY';

export const DEFAULT_VAULT_FETCH_TIMEOUT_MS = 120_000;
export const VAULT_FETCH_RETRY_INTERVAL_MS = 5_000;

const SECRET_KEY = 'CRON_SECRET';

export interface VaultCronSecret {
  secret: string;
  /** The grant's single deferred ack — call `used()` on first real use. */
  ack: GrantAckHandle;
}

export interface VaultSecretDeps {
  loadFromVault?: (params: LoadFromVaultParams) => Promise<VaultCredentials>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: CronLogLine) => void;
}

async function defaultLoadFromVault(params: LoadFromVaultParams): Promise<VaultCredentials> {
  const { loadFromVault } = await import('@imajin/auth');
  return loadFromVault(params);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CRON_VAULT_FETCH_TIMEOUT_MS?.trim();
  const configured = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_VAULT_FETCH_TIMEOUT_MS;
}

function vaultFailure(did: string, timeoutMs: number, lastError: string): Error {
  return new Error(
    `could not fetch the cron secret from the vault (purpose '${CRON_SECRET_PURPOSE}', identity ${did}) ` +
      `within ${Math.round(timeoutMs / 1000)}s: ${lastError}. This is a vault problem, not an .env.local one: ` +
      'the deploy grants this purpose to the identity in scripts/provision-service-bootstrap.mjs — ' +
      "check that step's log and that the kernel is up. Nothing needs to be set by hand.",
  );
}

/** One fetch attempt: the secret + its ack, or a (secret-free) description of why not. */
async function tryFetch(
  load: NonNullable<VaultSecretDeps['loadFromVault']>,
  did: string,
  privateKey: string,
  authServiceUrl: string,
): Promise<VaultCronSecret | { error: string }> {
  try {
    const credentials = await load({
      resolveGrantByPurpose: CRON_SECRET_PURPOSE,
      purpose: 'kernel-cron.boot.cron-secret',
      keys: [{ key: SECRET_KEY, onMissing: 'fail' }],
      identity: { did, privateKey },
      authServiceUrl,
    });
    const secret = credentials.values[SECRET_KEY];
    const ack = credentials.acks[SECRET_KEY];
    return secret && ack ? { secret, ack } : { error: 'the vault returned no value for the grant' };
  } catch (err) {
    // loadFromVault's errors never contain a fetched value, key or token.
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch the cron secret from the vault as the scheduler's bootstrap identity.
 *
 * @param authServiceUrl the kernel's auth base (`<loopback base>/auth`), passed
 *   explicitly so the bootstrap signature and the returned secret can only ever
 *   travel to the loopback address the scheduler already validated.
 */
export async function loadCronSecretFromVault(
  env: NodeJS.ProcessEnv,
  authServiceUrl: string,
  deps: VaultSecretDeps = {},
): Promise<VaultCronSecret> {
  const did = env[BOOTSTRAP_DID_ENV]?.trim();
  const privateKey = env[BOOTSTRAP_PRIVATE_KEY_ENV]?.trim();
  if (!did || !privateKey) {
    throw new Error(
      `${BOOTSTRAP_DID_ENV} / ${BOOTSTRAP_PRIVATE_KEY_ENV} are not set — the cron scheduler cannot reach the vault. ` +
        'The deploy mints this identity and its cron-secret grant (scripts/provision-service-bootstrap.mjs); ' +
        "a missing pair means that step did not run for this host. Nothing is hand-minted or pasted into .env.local.",
    );
  }

  const load = deps.loadFromVault ?? defaultLoadFromVault;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const timeoutMs = fetchTimeoutMs(env);
  const deadline = now() + timeoutMs;

  const attempt = async (): Promise<VaultCronSecret> => {
    const outcome = await tryFetch(load, did, privateKey, authServiceUrl);
    if ('secret' in outcome) return outcome;

    if (now() + VAULT_FETCH_RETRY_INTERVAL_MS > deadline) throw vaultFailure(did, timeoutMs, outcome.error);
    log({ level: 'warn', event: 'cron.vault-fetch-retry', error: outcome.error });
    await sleep(VAULT_FETCH_RETRY_INTERVAL_MS);
    return attempt();
  };
  return attempt();
}
