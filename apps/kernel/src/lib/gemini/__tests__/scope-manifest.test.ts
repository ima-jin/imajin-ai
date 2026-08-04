import { describe, it, expect, vi } from 'vitest';

// ─── Gemini scope-manifest wrapper tests ──────────────────────────────────────
//
// Tests the Gemini-specific layer: descriptor values, constants, and that the
// wrapper functions delegate to scope-manifest-core with the right parameters.
// The core logic (DB queries, consent grant sync, publish orchestration) is
// tested in kernel/__tests__/scope-manifest-core.test.ts.

const { mockBuild, mockFind, mockReadActive, mockSync, mockPublish } = vi.hoisted(() => ({
  mockBuild: vi.fn(() => 'yaml-content'),
  mockFind: vi.fn(async () => null),
  mockReadActive: vi.fn(async () => []),
  mockSync: vi.fn(async () => undefined),
  mockPublish: vi.fn(async () => 'asset_gem'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => ({
  buildConnectorManifestContent: mockBuild,
  findConnectorManifestAsset: mockFind,
  readActiveConnectorScopes: mockReadActive,
  syncConnectorConsentGrants: mockSync,
  publishConnectorScopeManifest: mockPublish,
}));

const { existsMock, statusMock } = vi.hoisted(() => ({
  existsMock: vi.fn().mockResolvedValue(false),
  statusMock: vi.fn().mockResolvedValue('absent'),
}));
vi.mock('../connector', () => ({
  GEMINI_CONNECTOR_DID: 'did:imajin:gemini-connector',
  vaultField: (did: string) => `gemini-api-key:${did}`,
  geminiKeyPending: (did: string) => statusMock(`gemini-api-key:${did}`).then((s: string) => s === 'pending-grant'),
}));
vi.mock('@/src/lib/vault', () => ({ vaultFieldExists: existsMock, vaultFieldStatus: statusMock }));

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

describe('GEMINI_SCOPE_DESCRIPTORS', () => {
  it('defines gemini:infer as owner-only (sensitive, not disclosing others)', () => {
    expect(VALID_GEMINI_SCOPES).toEqual(['gemini:infer']);
    const r = GEMINI_SCOPE_DESCRIPTORS['gemini:infer'].release;
    expect(r.discloses_others).toBe(false);
    expect(r.sensitive).toBe(true);
    expect(r.viewer).toBe(GEMINI_CONNECTOR_DID);
  });
});

describe('buildManifestContent', () => {
  it('calls buildConnectorManifestContent with Gemini DID, channel, descriptors', () => {
    buildManifestContent(['gemini:infer']);
    expect(mockBuild).toHaveBeenCalledWith(
      GEMINI_CONNECTOR_DID, 'gemini', GEMINI_SCOPE_DESCRIPTORS, ['gemini:infer'],
    );
  });
});

describe('findGeminiManifestAsset', () => {
  it('calls findConnectorManifestAsset with Gemini DID', async () => {
    await findGeminiManifestAsset('did:owner');
    expect(mockFind).toHaveBeenCalledWith('did:owner', GEMINI_CONNECTOR_DID);
  });
});

describe('readActiveGeminiScopes', () => {
  it('calls readActiveConnectorScopes with gemini channel and Gemini DID', async () => {
    await readActiveGeminiScopes('did:owner');
    expect(mockReadActive).toHaveBeenCalledWith('did:owner', 'gemini', GEMINI_CONNECTOR_DID);
  });
});

describe('syncConsentGrants', () => {
  /**
   * gemini:infer derives `owner-only` from the #1196 2×2 (#1253), not
   * `on-consent` — but it still sits behind a consent barrier, so publishing it
   * must record a consent_grants row exactly as before. This asserts the tier
   * change did not silently drop that row.
   */
  it('records a consent row for gemini:infer (owner-only is still consent-barriered)', async () => {
    await syncConsentGrants('did:owner', 'asset_x', ['gemini:infer']);
    const [, connDid, , , isOnConsent] = mockSync.mock.calls[0];
    expect(connDid).toBe(GEMINI_CONNECTOR_DID);
    expect(isOnConsent('gemini:infer')).toBe(true);
  });
});

describe('publishGeminiScopeManifest', () => {
  it('calls publishConnectorScopeManifest with correct Gemini opts', async () => {
    await publishGeminiScopeManifest('did:owner', ['gemini:infer']);
    const opts = mockPublish.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.connectorDid).toBe(GEMINI_CONNECTOR_DID);
    expect(opts.channel).toBe('gemini');
    expect(opts.filename).toBe('gemini-scope-manifest.md');
  });
});

describe('geminiKeySealed', () => {
  it('delegates to vaultFieldExists with the per-DID field', async () => {
    existsMock.mockResolvedValueOnce(true);
    expect(await geminiKeySealed('did:owner')).toBe(true);
    expect(existsMock).toHaveBeenCalledWith('gemini-api-key:did:owner');
  });
});

describe('geminiKeyPending re-export (#1521)', () => {
  it('is re-exported from scope-manifest.ts so the route can import it from one place', async () => {
    statusMock.mockResolvedValue('pending-grant');
    expect(await geminiKeyPending('did:owner')).toBe(true);
  });
});
