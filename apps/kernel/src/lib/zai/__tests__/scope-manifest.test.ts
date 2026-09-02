/**
 * Z.ai scope-manifest tests (#1931).
 *
 * The identity contract itself — every delegation into scope-manifest-core
 * must carry the Z.ai connector DID and channel — is shared with every other
 * token-paste connector; see `describeScopeManifestIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * provider-specific mock wiring lives here.
 */
import { vi } from 'vitest';
import { describeScopeManifestIdentityContract } from '@/src/lib/kernel/__tests__/brain-connector-contract';

const core = vi.hoisted(() => ({
  buildConnectorManifestContent: vi.fn(() => '---\nkind: scope-manifest\n---\n'),
  findConnectorManifestAsset: vi.fn(async () => null),
  readActiveConnectorScopes: vi.fn(async () => ['zai:infer']),
  syncConnectorConsentGrants: vi.fn(async () => undefined),
  publishConnectorScopeManifest: vi.fn(async () => 'asset_1'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

vi.mock('../connector', () => ({
  ZAI_CONNECTOR_DID: 'did:imajin:zai-connector',
  ZAI_CHANNEL: 'zai',
  zaiKeySealed: vi.fn(),
  zaiKeyPending: vi.fn(),
}));

import {
  ZAI_SCOPE_DESCRIPTORS,
  VALID_ZAI_SCOPES,
  buildManifestContent,
  findZaiManifestAsset,
  readActiveZaiScopes,
  syncConsentGrants,
  publishZaiScopeManifest,
} from '../scope-manifest';

describeScopeManifestIdentityContract({
  label: 'Z.ai',
  id: 'zai',
  connectorDid: 'did:imajin:zai-connector',
  channel: 'zai',
  inferScope: 'zai:infer',
  filename: 'zai-scope-manifest.md',
  core,
  scopeDescriptors: ZAI_SCOPE_DESCRIPTORS,
  validScopes: VALID_ZAI_SCOPES,
  buildManifestContent,
  findManifestAsset: findZaiManifestAsset,
  readActiveScopes: readActiveZaiScopes,
  syncConsentGrants,
  publishScopeManifest: publishZaiScopeManifest,
});
