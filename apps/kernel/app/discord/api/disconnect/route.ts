import { createDisconnectHandler } from '@/src/lib/kernel/connector-oauth-routes';
import { DISCORD_CONNECTOR_DID } from '@/src/lib/discord/connector';

/** POST /discord/api/disconnect — purge sealed Discord bot token and revoke the grant. */
export const POST = createDisconnectHandler({
  vaultPrefixes: ['discord-bot-token'],
  channel: 'discord',
  connectorDid: DISCORD_CONNECTOR_DID,
  connectorName: 'discord',
});
