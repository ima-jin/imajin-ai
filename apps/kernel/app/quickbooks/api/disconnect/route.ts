import { createDisconnectHandler } from '@/src/lib/kernel/connector-oauth-routes';
import { QUICKBOOKS_CONNECTOR_DID } from '@/src/lib/quickbooks/connector';

/** POST /quickbooks/api/disconnect — purge sealed QuickBooks credentials and revoke the grant. */
export const POST = createDisconnectHandler({
  vaultPrefixes: ['quickbooks-config', 'quickbooks-oauth'],
  channel: 'quickbooks',
  connectorDid: QUICKBOOKS_CONNECTOR_DID,
  connectorName: 'quickbooks',
});
