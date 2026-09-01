import { describe, it, expect, vi, beforeEach } from 'vitest';
import { describeScopeManifestIdentityContract } from '@/src/lib/kernel/__tests__/brain-connector-contract';

// ─── Anthropic scope-manifest wrapper tests (#1621) ──────────────────────────────
//
// The identity contract is shared with every other token-paste connector;
// see `describeScopeManifestIdentityContract` in
// `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
// provider-specific mock wiring and the `#1774` re-export regression live
// here.

const core = vi.hoisted(() => ({
  buildConnectorManifestContent: vi.fn(() => 'yaml-content'),
  findConnectorManifestAsset: vi.fn(async () => null),
  readActiveConnectorScopes: vi.fn(async () => ['anthropic:infer']),
  syncConnectorConsentGrants: vi.fn(async () => undefined),
  publishConnectorScopeManifest: vi.fn(async () => 'asset_1'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

const { sealedMock, statusMock } = vi.hoisted(() => ({
  sealedMock: vi.fn().mockResolvedValue(false),
  statusMock: vi.fn().mockResolvedValue('absent'),
}));

vi.mock('../connector', () => ({
  ANTHROPIC_CONNECTOR_DID: 'did:imajin:anthropic-connector',
  anthropicKeySealed: sealedMock,
  anthropicKeyPending: (did: string) =>
    statusMock(`anthropic-api-key:${did}`).then((s: string) => s === 'pending-grant'),
}));

import {
  buildManifestContent,
  findAnthropicManifestAsset,
  readActiveAnthropicScopes,
  syncConsentGrants,
  publishAnthropicScopeManifest,
  anthropicKeySealed,
  anthropicKeyPending,
  VALID_ANTHROPIC_SCOPES,
  ANTHROPIC_SCOPE_DESCRIPTORS,
} from '../scope-manifest';
import { ANTHROPIC_CONNECTOR_DID } from '../connector';

beforeEach(() => {
  sealedMock.mockReset();
  sealedMock.mockResolvedValue(false);
  statusMock.mockReset();
  statusMock.mockResolvedValue('absent');
});

describeScopeManifestIdentityContract({
  label: 'Anthropic',
  id: 'anthropic',
  connectorDid: ANTHROPIC_CONNECTOR_DID,
  channel: 'anthropic',
  inferScope: 'anthropic:infer',
  filename: 'anthropic-scope-manifest.md',
  core,
  scopeDescriptors: ANTHROPIC_SCOPE_DESCRIPTORS,
  validScopes: VALID_ANTHROPIC_SCOPES,
  buildManifestContent,
  findManifestAsset: findAnthropicManifestAsset,
  readActiveScopes: readActiveAnthropicScopes,
  syncConsentGrants,
  publishScopeManifest: publishAnthropicScopeManifest,
});

describe('credential status', () => {
  // A local vaultFieldExists-based redefinition here (as before #1774) would
  // shadow the grant-aware fix ./connector already made for #1724, leaving a
  // disconnected key reporting `keySealed: true` forever on this route
  // specifically.
  it('re-exports anthropicKeySealed from ./connector', async () => {
    sealedMock.mockResolvedValueOnce(true);
    expect(await anthropicKeySealed('did:owner')).toBe(true);
    expect(sealedMock).toHaveBeenCalledWith('did:owner');
  });

  it('re-exports anthropicKeyPending so the route imports from one place', async () => {
    statusMock.mockResolvedValue('pending-grant');
    expect(await anthropicKeyPending('did:owner')).toBe(true);
  });
});
