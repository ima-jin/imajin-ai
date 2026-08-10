import { buildAuthorizeUrl } from '@/src/lib/quickbooks/connector';
import { signState } from '@/src/lib/quickbooks/oauth-state';
import { createConnectHandler, resolveConfigDidFromAppAuth } from '@/src/lib/kernel/connector-oauth-routes';

/** Must match `configPrefix: 'quickbooks-config'` in `src/lib/quickbooks/connector.ts`. */
const QUICKBOOKS_CONFIG_PREFIX = 'quickbooks-config';

/**
 * GET /quickbooks/api/connect — begin the Intuit OAuth2 authorization-code
 * flow. When the request carries app-auth headers (#1704), the flow
 * authorizes against the delegating app's own sealed Intuit client
 * credentials instead of the session owner's — the split app-owned-config
 * model. Absent app-auth headers, behaviour is unchanged (BYO-app).
 *
 * When the app itself has no config sealed, #1770 walks to the app's
 * registrant DID (`registry_apps.ownerDid`) before falling back to the app
 * DID — the same hop `resolveBrain` (#1621) already takes for inference
 * credentials.
 */
export const GET = createConnectHandler(
  buildAuthorizeUrl,
  signState,
  (request) => resolveConfigDidFromAppAuth(request, QUICKBOOKS_CONFIG_PREFIX),
);
