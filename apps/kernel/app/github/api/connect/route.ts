import { buildAuthorizeUrl } from '@/src/lib/github/connector';
import { signState } from '@/src/lib/github/oauth-state';
import { createConnectHandler } from '@/src/lib/kernel/connector-oauth-routes';

/** GET /github/api/connect — begin the GitHub OAuth2 authorization-code flow. */
export const GET = createConnectHandler(buildAuthorizeUrl, signState);
