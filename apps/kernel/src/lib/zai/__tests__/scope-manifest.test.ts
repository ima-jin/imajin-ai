/**
 * Z.ai scope-manifest tests (#1931).
 *
 * The identity contract itself — every delegation into scope-manifest-core
 * must carry the Z.ai connector DID and channel — is shared with every other
 * token-paste connector; see `describeScopeManifestIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * provider-specific mock wiring lives here.
 */
import { vi, it, expect } from 'vitest';
import {
  describeScopeManifestIdentityContract,
  expectKeyStatusReExportedFromConnector,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

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
  zaiKeySealed,
  zaiKeyPending,
} from '../scope-manifest';
import { zaiKeySealed as connectorKeySealed, zaiKeyPending as connectorKeyPending } from '../connector';

// Direct, literal it() with a literal expect() on the helper's return value
// (see expectKeyStatusReExportedFromConnector's doc comment) so Sonar S2699
// recognizes this file as containing a real assertion.
it('re-exports zaiKeySealed/zaiKeyPending from ./connector rather than redefining them locally', () => {
  expect(expectKeyStatusReExportedFromConnector(
    { keySealed: zaiKeySealed, keyPending: zaiKeyPending },
    { keySealed: connectorKeySealed, keyPending: connectorKeyPending },
  )).toBe(true);
});

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
