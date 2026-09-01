import { describe, it, expect, vi } from 'vitest';
import { describeScopeManifestIdentityContract } from '@/src/lib/kernel/__tests__/brain-connector-contract';

// ─── Gemini scope-manifest wrapper tests ────────────────────────────────────────
//
// The identity contract — every delegation into scope-manifest-core must
// carry the Gemini connector DID and channel — is shared with every other
// token-paste connector; see `describeScopeManifestIdentityContract` in
// `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
// provider-specific mock wiring and the `#1774` re-export regression live
// here.

const core = vi.hoisted(() => ({
  buildConnectorManifestContent: vi.fn(() => 'yaml-content'),
  findConnectorManifestAsset: vi.fn(async () => null),
  readActiveConnectorScopes: vi.fn(async () => ['gemini:infer']),
  syncConnectorConsentGrants: vi.fn(async () => undefined),
  publishConnectorScopeManifest: vi.fn(async () => 'asset_1'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

const { sealedMock, statusMock } = vi.hoisted(() => ({
  sealedMock: vi.fn().mockResolvedValue(false),
  statusMock: vi.fn().mockResolvedValue('absent'),
}));
vi.mock('../connector', () => ({
  GEMINI_CONNECTOR_DID: 'did:imajin:gemini-connector',
  geminiKeySealed: sealedMock,
  geminiKeyPending: (did: string) => statusMock(`gemini-api-key:${did}`).then((s: string) => s === 'pending-grant'),
}));

import {
  buildManifestContent,
  findGeminiManifestAsset,
  readActiveGeminiScopes,
  syncConsentGrants,
  publishGeminiScopeManifest,
  geminiKeySealed,
  geminiKeyPending,
  VALID_GEMINI_SCOPES,
  GEMINI_SCOPE_DESCRIPTORS,
} from '../scope-manifest';
import { GEMINI_CONNECTOR_DID } from '../connector';

describeScopeManifestIdentityContract({
  label: 'Gemini',
  id: 'gemini',
  connectorDid: GEMINI_CONNECTOR_DID,
  channel: 'gemini',
  inferScope: 'gemini:infer',
  filename: 'gemini-scope-manifest.md',
  core,
  scopeDescriptors: GEMINI_SCOPE_DESCRIPTORS,
  validScopes: VALID_GEMINI_SCOPES,
  buildManifestContent,
  findManifestAsset: findGeminiManifestAsset,
  readActiveScopes: readActiveGeminiScopes,
  syncConsentGrants,
  publishScopeManifest: publishGeminiScopeManifest,
});

describe('geminiKeySealed re-export (#1774)', () => {
  it('is re-exported from ./connector rather than a local vaultFieldExists redefinition', async () => {
    // A local redefinition here (as before #1774) would shadow the grant-aware
    // fix ./connector already made for #1724, leaving a disconnected key
    // reporting `keySealed: true` forever on this route specifically.
    sealedMock.mockResolvedValueOnce(true);
    expect(await geminiKeySealed('did:owner')).toBe(true);
    expect(sealedMock).toHaveBeenCalledWith('did:owner');
  });
});

describe('geminiKeyPending re-export (#1521)', () => {
  it('is re-exported from scope-manifest.ts so the route can import it from one place', async () => {
    statusMock.mockResolvedValue('pending-grant');
    expect(await geminiKeyPending('did:owner')).toBe(true);
  });
});
