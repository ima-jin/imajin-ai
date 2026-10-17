import { exchangeCodeAndStore, resetGoogleConnectionState, captureGoogleAccountEmail } from '@/src/lib/google/connector';
import { verifyState } from '@/src/lib/google/oauth-state';
import { createCallbackHandler } from '@/src/lib/kernel/connector-oauth-routes';

/** GET /google/api/callback — Google redirects here with code + state (#2144). */
export const GET = createCallbackHandler({
  verifyState,
  connectorName: 'Google',
  connectorId: 'google',
  exchange: async (ownerDid, code, _params, configDid, slot) => {
    await exchangeCodeAndStore(ownerDid, code, {}, configDid, slot);
    await resetGoogleConnectionState(ownerDid, slot);
    await captureGoogleAccountEmail(ownerDid, slot);
  },
});
