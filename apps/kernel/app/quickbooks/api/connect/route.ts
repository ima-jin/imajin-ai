import { buildAuthorizeUrl } from '@/src/lib/quickbooks/connector';
import { signState } from '@/src/lib/quickbooks/oauth-state';
import { createConnectHandler, resolveConfigDidFromAppAuth } from '@/src/lib/kernel/connector-oauth-routes';

/**
 * GET /quickbooks/api/connect — begin the Intuit OAuth2 authorization-code
 * flow. When the request carries app-auth headers (#1704), the flow
 * authorizes against the delegating app's own sealed Intuit client
 * credentials instead of the session owner's — the split app-owned-config
 * model. Absent app-auth headers, behaviour is unchanged (BYO-app).
 */
export const GET = createConnectHandler(buildAuthorizeUrl, signState, resolveConfigDidFromAppAuth);
