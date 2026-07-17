import { buildAuthorizeUrl } from '@/src/lib/quickbooks/connector';
import { signState } from '@/src/lib/quickbooks/oauth-state';
import { createConnectHandler } from '@/src/lib/kernel/connector-oauth-routes';

/** GET /quickbooks/api/connect — begin the Intuit OAuth2 authorization-code flow. */
export const GET = createConnectHandler(buildAuthorizeUrl, signState);
