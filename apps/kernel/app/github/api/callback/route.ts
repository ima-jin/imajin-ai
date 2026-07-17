import { exchangeCodeAndStore } from '@/src/lib/github/connector';
import { verifyState } from '@/src/lib/github/oauth-state';
import { createCallbackHandler } from '@/src/lib/kernel/connector-oauth-routes';

/** GET /github/api/callback — GitHub redirects here with code + state (no realmId). */
export const GET = createCallbackHandler({
  verifyState,
  connectorName: 'GitHub',
  exchange: (ownerDid, code) => exchangeCodeAndStore(ownerDid, code),
});
