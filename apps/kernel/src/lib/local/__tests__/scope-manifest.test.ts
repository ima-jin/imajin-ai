/**
 * Local connector scope-manifest tests (#1957).
 *
 * Structurally identical to every other token-paste connector's
 * scope-manifest wrapper, so the identity contract itself is shared — see
 * `describeScopeManifestIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * connector-specific mock wiring lives here.
 */
import { vi, it, expect } from 'vitest';
import { describeScopeManifestIdentityContract } from '@/src/lib/kernel/__tests__/brain-connector-contract';

const core = vi.hoisted(() => ({
  buildConnectorManifestContent: vi.fn(() => '---\nkind: scope-manifest\n---\n'),
  findConnectorManifestAsset: vi.fn(async () => null),
  readActiveConnectorScopes: vi.fn(async () => ['local:infer']),
  syncConnectorConsentGrants: vi.fn(async () => undefined),
  publishConnectorScopeManifest: vi.fn(async () => 'asset_1'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

vi.mock('../connector', () => ({
  LOCAL_CONNECTOR_DID: 'did:imajin:local-connector',
  LOCAL_CHANNEL: 'local',
}));

import * as localScopeManifestModule from '../scope-manifest';
import {
  LOCAL_SCOPE_DESCRIPTORS,
  VALID_LOCAL_SCOPES,
  buildManifestContent,
  findLocalManifestAsset,
  readActiveLocalScopes,
  syncConsentGrants,
  publishLocalScopeManifest,
} from '../scope-manifest';

// Direct, literal assertion (rather than only delegating to the shared
// contract below) so this file itself is recognized as containing test
// cases. See the module doc comment on brain-connector-contract.ts. Also a
// real guard on this connector's documented design (connector.ts: "no key
// is local's normal resolved state") — unlike every other token-paste
// connector, local has no vault-sealed key to report a KeySealed/KeyPending
// pair for, so this module must not accidentally grow one.
it('does not export a KeySealed/KeyPending pair (local has no vault-sealed key)', () => {
  expect(localScopeManifestModule).not.toHaveProperty('localKeySealed');
  expect(localScopeManifestModule).not.toHaveProperty('localKeyPending');
});

describeScopeManifestIdentityContract({
  label: 'Local Inference',
  id: 'local',
  connectorDid: 'did:imajin:local-connector',
  channel: 'local',
  inferScope: 'local:infer',
  filename: 'local-scope-manifest.md',
  core,
  scopeDescriptors: LOCAL_SCOPE_DESCRIPTORS,
  validScopes: VALID_LOCAL_SCOPES,
  buildManifestContent,
  findManifestAsset: findLocalManifestAsset,
  readActiveScopes: readActiveLocalScopes,
  syncConsentGrants,
  publishScopeManifest: publishLocalScopeManifest,
});
