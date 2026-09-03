/**
 * GET + POST /local/api/scope-manifest (#1957)
 *
 * Wires the shared scope-manifest route factory for the local connector.
 * `keySealed` in the GET response drives the connector card's existing
 * credential-sealed gate (model picker + scope toggles) — for `local` it
 * reports whether a `baseUrl` is CONFIGURED, not whether a bearer token is
 * sealed, since a `local` connection with no token is this connector's
 * normal, fully-usable state (see `../../../src/lib/local/connector.ts`).
 * `credentialPending` mirrors the bearer token's own (optional) custody
 * state, distinct from `keySealed`.
 */
import { createConnectorScopeManifestRoute } from '@/src/lib/kernel/scope-manifest-route';
import {
  publishLocalScopeManifest,
  readActiveLocalScopes,
  findLocalManifestAsset,
  VALID_LOCAL_SCOPES,
} from '@/src/lib/local/scope-manifest';
import { baseUrlConfigured, bearerTokenPending } from '@/src/lib/local/connector';

export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({
  name: 'Local Inference',
  validScopes: VALID_LOCAL_SCOPES,
  findManifestAsset: findLocalManifestAsset,
  readActiveScopes: readActiveLocalScopes,
  publish: publishLocalScopeManifest,
  getExtraFields: async (ownerDid) => {
    const [keySealed, credentialPending] = await Promise.all([
      baseUrlConfigured(ownerDid),
      bearerTokenPending(ownerDid),
    ]);
    return { keySealed, credentialPending };
  },
});
