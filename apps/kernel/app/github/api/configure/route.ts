import { storeConfig, type GitHubConfig } from '@/src/lib/github/connector';
import { createConfigureHandler } from '@/src/lib/kernel/connector-oauth-routes';

/**
 * OPTIONS + POST /github/api/configure — seal per-DID OAuth app config.
 *
 * Accepts either BYO shape (#1391): `{ clientId }` for device flow, or
 * `{ clientId, clientSecret, redirectUri }` for authorization code.
 */
export const { OPTIONS, POST } = createConfigureHandler<GitHubConfig>({
  // GitHub config has no extra fields beyond the base ones.
  buildConfig: (base) => base as GitHubConfig,
  storeConfig,
  // GitHub implements RFC 8628 at https://github.com/login/device/code.
  supportsDeviceFlow: true,
});
