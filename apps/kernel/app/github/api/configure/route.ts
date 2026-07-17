import { storeConfig, type GitHubConfig } from '@/src/lib/github/connector';
import { createConfigureHandler } from '@/src/lib/kernel/connector-oauth-routes';

/** OPTIONS + POST /github/api/configure — seal per-DID OAuth app config. */
export const { OPTIONS, POST } = createConfigureHandler<GitHubConfig>({
  // GitHub config has no extra fields beyond the base three.
  buildConfig: (base) => base as GitHubConfig,
  storeConfig,
});
