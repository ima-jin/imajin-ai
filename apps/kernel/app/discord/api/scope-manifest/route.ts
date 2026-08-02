/**
 * GET + POST /discord/api/scope-manifest (#1355)
 *
 * Wires the shared scope-manifest route factory for the Discord connector
 * (Pattern B — token-paste). GET returns { manifestAssetId, activeScopes,
 * validScopes, tokenSealed }. POST validates scopes fail-closed, publishes,
 * returns { published, assetId, activeScopes }.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishDiscordScopeManifest,
  readActiveDiscordScopes,
  findDiscordManifestAsset,
  discordTokenSealed,
  discordCredentialPending,
  VALID_DISCORD_SCOPES,
} from '@/src/lib/discord/scope-manifest';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Discord',
  validScopes: VALID_DISCORD_SCOPES,
  findManifestAsset: findDiscordManifestAsset,
  readActiveScopes: readActiveDiscordScopes,
  publish: publishDiscordScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [tokenSealed, credentialPending] = await Promise.all([
      discordTokenSealed(ownerDid),
      discordCredentialPending(ownerDid),
    ]);
    return { tokenSealed, credentialPending };
  },
});
