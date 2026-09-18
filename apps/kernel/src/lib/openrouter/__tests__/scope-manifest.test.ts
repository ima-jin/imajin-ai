/**
 * OpenRouter scope-manifest tests (#2188).
 *
 * The identity contract itself — every delegation into scope-manifest-core
 * must carry the OpenRouter connector DID and channel — is shared with every
 * other token-paste connector; see `describeScopeManifestIdentityContract` in
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
  readActiveConnectorScopes: vi.fn(async () => ['openrouter:infer']),
  syncConnectorConsentGrants: vi.fn(async () => undefined),
  publishConnectorScopeManifest: vi.fn(async () => 'asset_1'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

vi.mock('../connector', () => ({
  OPENROUTER_CONNECTOR_DID: 'did:imajin:openrouter-connector',
  OPENROUTER_CHANNEL: 'openrouter',
  openrouterKeySealed: vi.fn(),
  openrouterKeyPending: vi.fn(),
}));

import {
  OPENROUTER_SCOPE_DESCRIPTORS,
  VALID_OPENROUTER_SCOPES,
  buildManifestContent,
  findOpenrouterManifestAsset,
  readActiveOpenrouterScopes,
  syncConsentGrants,
  publishOpenrouterScopeManifest,
  openrouterKeySealed,
  openrouterKeyPending,
} from '../scope-manifest';
import { openrouterKeySealed as connectorKeySealed, openrouterKeyPending as connectorKeyPending } from '../connector';

// Direct, literal it() with a literal expect() on the helper's return value
// (see expectKeyStatusReExportedFromConnector's doc comment) so Sonar S2699
// recognizes this file as containing a real assertion.
it('re-exports openrouterKeySealed/openrouterKeyPending from ./connector rather than redefining them locally', () => {
  expect(expectKeyStatusReExportedFromConnector(
    { keySealed: openrouterKeySealed, keyPending: openrouterKeyPending },
    { keySealed: connectorKeySealed, keyPending: connectorKeyPending },
  )).toBe(true);
});

describeScopeManifestIdentityContract({
  label: 'OpenRouter',
  id: 'openrouter',
  connectorDid: 'did:imajin:openrouter-connector',
  channel: 'openrouter',
  inferScope: 'openrouter:infer',
  filename: 'openrouter-scope-manifest.md',
  core,
  scopeDescriptors: OPENROUTER_SCOPE_DESCRIPTORS,
  validScopes: VALID_OPENROUTER_SCOPES,
  buildManifestContent,
  findManifestAsset: findOpenrouterManifestAsset,
  readActiveScopes: readActiveOpenrouterScopes,
  syncConsentGrants,
  publishScopeManifest: publishOpenrouterScopeManifest,
});
