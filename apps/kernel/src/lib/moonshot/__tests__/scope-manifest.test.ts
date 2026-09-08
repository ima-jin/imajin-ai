/**
 * Moonshot scope-manifest tests (#1930).
 *
 * The identity contract itself — every delegation into scope-manifest-core
 * must carry the Moonshot connector DID and channel — is shared with every
 * other token-paste connector; see `describeScopeManifestIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * provider-specific mock wiring lives here.
 */
import { vi, it, expect } from 'vitest';
import { describeScopeManifestIdentityContract } from '@/src/lib/kernel/__tests__/brain-connector-contract';

const core = vi.hoisted(() => ({
  buildConnectorManifestContent: vi.fn(() => '---\nkind: scope-manifest\n---\n'),
  findConnectorManifestAsset: vi.fn(async () => null),
  readActiveConnectorScopes: vi.fn(async () => ['moonshot:infer']),
  syncConnectorConsentGrants: vi.fn(async () => undefined),
  publishConnectorScopeManifest: vi.fn(async () => 'asset_1'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

vi.mock('../connector', () => ({
  MOONSHOT_CONNECTOR_DID: 'did:imajin:moonshot-connector',
  MOONSHOT_CHANNEL: 'moonshot',
  moonshotKeySealed: vi.fn(),
  moonshotKeyPending: vi.fn(),
}));

import {
  MOONSHOT_SCOPE_DESCRIPTORS,
  VALID_MOONSHOT_SCOPES,
  buildManifestContent,
  findMoonshotManifestAsset,
  readActiveMoonshotScopes,
  syncConsentGrants,
  publishMoonshotScopeManifest,
  moonshotKeySealed,
  moonshotKeyPending,
} from '../scope-manifest';
import { moonshotKeySealed as connectorKeySealed, moonshotKeyPending as connectorKeyPending } from '../connector';

// Direct, literal assertion (rather than only delegating to the shared
// contract below) so this file itself is recognized as containing test
// cases. See the module doc comment on brain-connector-contract.ts. Also a
// real regression guard (#1774 pattern): a local redefinition here would
// shadow the grant-aware moonshotKeySealed/moonshotKeyPending ./connector exports.
it('re-exports moonshotKeySealed/moonshotKeyPending from ./connector rather than redefining them locally', () => {
  expect(moonshotKeySealed).toBe(connectorKeySealed);
  expect(moonshotKeyPending).toBe(connectorKeyPending);
});

describeScopeManifestIdentityContract({
  label: 'Moonshot AI',
  id: 'moonshot',
  connectorDid: 'did:imajin:moonshot-connector',
  channel: 'moonshot',
  inferScope: 'moonshot:infer',
  filename: 'moonshot-scope-manifest.md',
  core,
  scopeDescriptors: MOONSHOT_SCOPE_DESCRIPTORS,
  validScopes: VALID_MOONSHOT_SCOPES,
  buildManifestContent,
  findManifestAsset: findMoonshotManifestAsset,
  readActiveScopes: readActiveMoonshotScopes,
  syncConsentGrants,
  publishScopeManifest: publishMoonshotScopeManifest,
});
