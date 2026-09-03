/**
 * Local connector scope-manifest tests (#1957).
 *
 * Structurally identical to every other token-paste connector's
 * scope-manifest wrapper, so the identity contract itself is shared — see
 * `describeScopeManifestIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * connector-specific mock wiring lives here.
 */
import { vi } from 'vitest';
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

import {
  LOCAL_SCOPE_DESCRIPTORS,
  VALID_LOCAL_SCOPES,
  buildManifestContent,
  findLocalManifestAsset,
  readActiveLocalScopes,
  syncConsentGrants,
  publishLocalScopeManifest,
} from '../scope-manifest';

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
