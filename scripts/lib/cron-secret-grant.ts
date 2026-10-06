/**
 * scripts/lib/cron-secret-grant.ts
 *
 * The one code path that grants the kernel's `CRON_SECRET` internal secret
 * (#2550, under epic #2241 — the #2245 pattern, sibling of
 * `./attestation-internal-api-key-grant.ts`) to the `*-kernel-cron` scheduler's
 * bootstrap identity. Called by `scripts/provision-service-bootstrap.mjs` for
 * the kernel's `KERNEL_CRON_VAULT_BOOTSTRAP_DID`, i.e. on the deploy tap — never
 * by a human pasting a value.
 *
 * Idempotent (see `grantInternalSecretTo`): a grantee that already holds an
 * active grant gets that grant's id back, no new row. The secret itself is
 * generated in the vault by the first call (`getInternalSecret`), per
 * environment: each vault file (dev, prod) holds its own value.
 *
 * Importing this module loads the kernel's vault + DB layer, so it needs the
 * kernel's env (`DATABASE_URL`, `AUTH_PRIVATE_KEY`, optional `VAULT_PATH`).
 */
import { grantInternalSecretTo } from '../../apps/kernel/src/lib/vault/index.js';
import { CRON_SECRET_PURPOSE } from '../../apps/kernel/src/cron/secret-purpose.js';

export { CRON_SECRET_PURPOSE };

export type CronSecretGrantOutcome = Awaited<ReturnType<typeof grantInternalSecretTo>>;

/**
 * Ensure `granteeDid` holds an active grant of the cron secret. `grantedBy` is
 * the acting principal recorded on the grant's audit log line.
 */
export function ensureCronSecretGrant(granteeDid: string, grantedBy: string): Promise<CronSecretGrantOutcome> {
  return grantInternalSecretTo(CRON_SECRET_PURPOSE, granteeDid, grantedBy);
}
