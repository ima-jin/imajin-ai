import { createDisconnectHandler } from '@/src/lib/kernel/connector-oauth-routes';
import { GITHUB_CONNECTOR_DID } from '@/src/lib/github/connector';

/** POST /github/api/disconnect — purge sealed GitHub credentials and revoke the grant. */
export const POST = createDisconnectHandler({
  vaultPrefixes: ['github-config', 'github-oauth', 'github-pat'],
  channel: 'github',
  connectorDid: GITHUB_CONNECTOR_DID,
  connectorName: 'github',
});
