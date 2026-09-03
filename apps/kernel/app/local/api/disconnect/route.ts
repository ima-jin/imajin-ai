/**
 * POST + OPTIONS /local/api/disconnect (#1957)
 *
 * Full disconnect for the local connector: revokes the bearer token's
 * delegation grant (if any) and every active `local:infer` channel_links
 * row, then clears the sealed `baseUrl` + pinned IP + model id. Unlike a
 * token-only connector's disconnect (which leaves the sealed key in place
 * for a one-click re-grant), there is nothing worth preserving once the
 * endpoint itself is disconnected — see `../../../src/lib/local/connector.ts`'s
 * `disconnect`.
 */
import { createConnectorTokenDisconnectRoute } from '@/src/lib/kernel/connector-token-route';
import { disconnect } from '@/src/lib/local/connector';

export const { POST, OPTIONS } = createConnectorTokenDisconnectRoute({
  name: 'Local Inference',
  revokeApiKey: disconnect,
});
