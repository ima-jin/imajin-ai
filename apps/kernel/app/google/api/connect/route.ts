import { buildAuthorizeUrl } from '@/src/lib/google/connector';
import { signState } from '@/src/lib/google/oauth-state';
import { createConnectHandler } from '@/src/lib/kernel/connector-oauth-routes';

/** GET /google/api/connect — begin the Google OAuth2 authorization-code flow (#2144). */
export const GET = createConnectHandler(buildAuthorizeUrl, signState);
