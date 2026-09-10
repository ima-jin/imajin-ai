import { storeConfig, type GoogleConfig } from '@/src/lib/google/connector';
import { createConfigureHandler } from '@/src/lib/kernel/connector-oauth-routes';

/**
 * OPTIONS + POST /google/api/configure — seal per-DID OAuth app config (#2144).
 *
 * Accepts `{ clientId, clientSecret, redirectUri }` (authorization-code only —
 * Google has no RFC 8628 device-authorization endpoint, so device flow is not
 * offered here).
 */
export const { OPTIONS, POST } = createConfigureHandler<GoogleConfig>({
  // Google's config has no extra fields beyond the base ones.
  buildConfig: (base) => base as GoogleConfig,
  storeConfig,
});
