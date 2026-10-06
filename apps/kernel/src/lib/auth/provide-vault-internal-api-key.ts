/**
 * Hands `@imajin/auth` the kernel's vault-resolved `ATTESTATION_INTERNAL_API_KEY`
 * at boot (#2353 step 4).
 *
 * The kernel hosts the vault, so it resolves the value itself
 * (`getInternalSecret`) instead of going through `bootstrapInternalApiKey`
 * like the userspace services. This is the credential `requireAuth` /
 * `getSession` / `requireAppAuth` use for their act-as and app-validate calls
 * now that `packages/auth` has no `process.env` fallback.
 *
 * Never throws and never blocks boot: on failure it logs an error and those
 * calls fail closed.
 */
import { provideInternalApiKey } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { getInternalSecret } from '../vault/internal-secret';
import { ATTESTATION_INTERNAL_API_KEY_PURPOSE } from './require-internal-api-key';

const log = createLogger('kernel');

export async function provideVaultInternalApiKey(): Promise<void> {
  try {
    provideInternalApiKey(await getInternalSecret(ATTESTATION_INTERNAL_API_KEY_PURPOSE));
  } catch (err) {
    log.error(
      { err: String(err) },
      'Could not resolve ATTESTATION_INTERNAL_API_KEY from the vault at boot — internal act-as / app-validate calls will fail closed',
    );
  }
}
