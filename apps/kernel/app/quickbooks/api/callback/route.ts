import { exchangeCodeAndStore } from '@/src/lib/quickbooks/connector';
import { verifyState } from '@/src/lib/quickbooks/oauth-state';
import { createCallbackHandler, MissingCallbackParamError } from '@/src/lib/kernel/connector-oauth-routes';

/** GET /quickbooks/api/callback — Intuit redirects here with code, state, realmId. */
export const GET = createCallbackHandler({
  verifyState,
  connectorName: 'QuickBooks',
  exchange: async (ownerDid, code, searchParams) => {
    const realmId = searchParams.get('realmId');
    if (!realmId) throw new MissingCallbackParamError('realmId');
    await exchangeCodeAndStore(ownerDid, code, realmId);
  },
});
