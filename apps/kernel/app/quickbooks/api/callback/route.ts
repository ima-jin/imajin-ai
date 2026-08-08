import { exchangeCodeAndStore } from '@/src/lib/quickbooks/connector';
import { verifyState } from '@/src/lib/quickbooks/oauth-state';
import { createCallbackHandler, MissingCallbackParamError } from '@/src/lib/kernel/connector-oauth-routes';

/**
 * GET /quickbooks/api/callback — Intuit redirects here with code, state,
 * realmId. When the signed state carries an `appDid` (#1704, threaded in by
 * the connect route), the exchange loads Intuit client credentials from that
 * app's sealed config while still sealing the resulting tokens at ownerDid.
 */
export const GET = createCallbackHandler({
  verifyState,
  connectorName: 'QuickBooks',
  connectorId: 'quickbooks',
  exchange: async (ownerDid, code, searchParams, configDid) => {
    const realmId = searchParams.get('realmId');
    if (!realmId) throw new MissingCallbackParamError('realmId');
    if (configDid) {
      await exchangeCodeAndStore(ownerDid, code, realmId, configDid);
      return;
    }
    await exchangeCodeAndStore(ownerDid, code, realmId);
  },
});
