/**
 * GET + POST /local/api/token (#1957)
 *
 * Optional bearer-token credential for the local connector, wired through
 * the shared token-paste route factory. This is the ONLY optional
 * credential step in the connector: the owner may skip it entirely and
 * still use the connector once `baseUrl` is configured via
 * `/local/api/settings` — see `../../../src/lib/local/connector.ts`'s
 * header for why.
 *
 * `GET`'s `keySealed` here answers the literal question ("is a bearer token
 * sealed?") — distinct from the scope-manifest route's own `keySealed`
 * extra field, which reports `baseUrl` readiness for the connector card's
 * gating. The two are deliberately different questions on two different
 * routes.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealBearerToken, bearerTokenSealed } from '@/src/lib/local/connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'Local Inference',
  sealApiKey: sealBearerToken,
  keySealed: bearerTokenSealed,
});
