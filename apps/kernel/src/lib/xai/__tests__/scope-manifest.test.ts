/**
 * xAI scope-manifest tests (#1924).
 *
 * The identity contract itself — every delegation into scope-manifest-core
 * must carry the xAI connector DID and channel — is shared with every other
 * token-paste connector; see `describeScopeManifestIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts` (#1927). Only the
 * provider-specific mock wiring lives here.
 */
import { vi } from 'vitest';
import { describeScopeManifestIdentityContract } from '@/src/lib/kernel/__tests__/brain-connector-contract';

const core = vi.hoisted(() => ({
  buildConnectorManifestContent: vi.fn(() => '---\nkind: scope-manifest\n---\n'),
  findConnectorManifestAsset: vi.fn(async () => null),
  readActiveConnectorScopes: vi.fn(async () => ['xai:infer']),
  syncConnectorConsentGrants: vi.fn(async () => undefined),
  publishConnectorScopeManifest: vi.fn(async () => 'asset_1'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

vi.mock('../connector', () => ({
  XAI_CONNECTOR_DID: 'did:imajin:xai-connector',
  XAI_CHANNEL: 'xai',
  xaiKeySealed: vi.fn(),
  xaiKeyPending: vi.fn(),
}));

import {
  XAI_SCOPE_DESCRIPTORS,
  VALID_XAI_SCOPES,
  buildManifestContent,
  findXaiManifestAsset,
  readActiveXaiScopes,
  syncConsentGrants,
  publishXaiScopeManifest,
} from '../scope-manifest';

describeScopeManifestIdentityContract({
  label: 'xAI',
  id: 'xai',
  connectorDid: 'did:imajin:xai-connector',
  channel: 'xai',
  inferScope: 'xai:infer',
  filename: 'xai-scope-manifest.md',
  core,
  scopeDescriptors: XAI_SCOPE_DESCRIPTORS,
  validScopes: VALID_XAI_SCOPES,
  buildManifestContent,
  findManifestAsset: findXaiManifestAsset,
  readActiveScopes: readActiveXaiScopes,
  syncConsentGrants,
  publishScopeManifest: publishXaiScopeManifest,
});
