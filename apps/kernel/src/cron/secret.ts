import { createLogger } from '@imajin/logger';
import { CRON_SECRET_PURPOSE } from './secret-purpose';

const log = createLogger('kernel');

// Test seam only: `undefined` means "use the vault". Never set in production code.
let testOverride: string | null | undefined;

/**
 * The kernel's copy of the cron bearer secret, or `null` when it is
 * unavailable (callers must fail closed on `null`).
 *
 * The secret is a vault-generated internal secret (#2245 pattern): the kernel
 * self-provisions it on first use and self-grants it to its own node DID, and
 * `getInternalSecret` holds it in process memory only — it is never read from
 * `process.env`, written to disk, or logged. The same value is granted to the
 * `*-kernel-cron` scheduler's bootstrap identity (`scripts/lib/cron-secret-grant.ts`,
 * run by the deploy's provisioning step) so the scheduler can present it.
 *
 * The vault module is imported lazily so a route that never reaches this
 * (and its tests) does not load the kernel's DB layer.
 */
export async function resolveCronSecret(): Promise<string | null> {
  if (testOverride !== undefined) return testOverride;
  try {
    const { getInternalSecret } = await import('../lib/vault/internal-secret');
    const secret = await getInternalSecret(CRON_SECRET_PURPOSE);
    return secret || null;
  } catch (err) {
    log.error(
      { err: String(err), purpose: CRON_SECRET_PURPOSE },
      'cron secret could not be read from the vault — refusing cron requests (fail closed)',
    );
    return null;
  }
}

/** Test-only: pin the resolved secret (`null` = unavailable). */
export function _setCronSecretForTests(value: string | null): void {
  testOverride = value;
}

/** Test-only: go back to resolving from the vault. */
export function _resetCronSecretForTests(): void {
  testOverride = undefined;
}
