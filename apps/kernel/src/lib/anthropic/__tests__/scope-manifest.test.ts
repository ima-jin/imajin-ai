import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Anthropic scope-manifest wrapper tests (#1621) ──────────────────────────
//
// Tests the Anthropic-specific layer: descriptor values, constants, and that the
// wrapper delegates to scope-manifest-core with the right parameters. Core logic
// (DB queries, consent-grant sync, publish orchestration) is covered by
// kernel/__tests__/scope-manifest-core.test.ts.

const { mockBuild, mockFind, mockReadActive, mockSync, mockPublish } = vi.hoisted(() => ({
  mockBuild: vi.fn(() => 'yaml-content'),
  mockFind: vi.fn(async () => null),
  mockReadActive: vi.fn(async () => []),
  mockSync: vi.fn(async () => undefined),
  mockPublish: vi.fn(async () => 'asset_ant'),
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
  ANTHROPIC_CONNECTOR_DID: 'did:imajin:anthropic-connector',
  vaultField: (did: string) => `anthropic-api-key:${did}`,
  anthropicKeyPending: (did: string) =>
    statusMock(`anthropic-api-key:${did}`).then((s: string) => s === 'pending-grant'),
}));
vi.mock('@/src/lib/vault', () => ({ vaultFieldExists: existsMock, vaultFieldStatus: statusMock }));

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
  vi.clearAllMocks();
  existsMock.mockResolvedValue(false);
  statusMock.mockResolvedValue('absent');
});

describe('ANTHROPIC_SCOPE_DESCRIPTORS', () => {
  it('defines anthropic:infer as owner-only (sensitive, not disclosing others)', () => {
    expect(VALID_ANTHROPIC_SCOPES).toEqual(['anthropic:infer']);
    const r = ANTHROPIC_SCOPE_DESCRIPTORS['anthropic:infer'].release;
    expect(r.discloses_others).toBe(false);
    expect(r.sensitive).toBe(true);
    expect(r.viewer).toBe(ANTHROPIC_CONNECTOR_DID);
  });
});

describe('buildManifestContent', () => {
  it('calls the core builder with the Anthropic DID, channel, and descriptors', () => {
    buildManifestContent(['anthropic:infer']);
    expect(mockBuild).toHaveBeenCalledWith(
      ANTHROPIC_CONNECTOR_DID, 'anthropic', ANTHROPIC_SCOPE_DESCRIPTORS, ['anthropic:infer'],
    );
  });
});

describe('findAnthropicManifestAsset', () => {
  it('scopes the lookup to the Anthropic connector DID', async () => {
    await findAnthropicManifestAsset('did:owner');
    expect(mockFind).toHaveBeenCalledWith('did:owner', ANTHROPIC_CONNECTOR_DID);
  });
});

describe('readActiveAnthropicScopes', () => {
  it('reads the anthropic channel for the Anthropic connector DID', async () => {
    await readActiveAnthropicScopes('did:owner');
    expect(mockReadActive).toHaveBeenCalledWith('did:owner', 'anthropic', ANTHROPIC_CONNECTOR_DID);
  });
});

describe('syncConsentGrants', () => {
  /**
   * owner-only is still consent-barriered: publishing anthropic:infer must
   * record a consent_grants row, exactly as gemini:infer does.
   */
  it('records a consent row for anthropic:infer', async () => {
    await syncConsentGrants('did:owner', 'asset_x', ['anthropic:infer']);
    const [, connDid, , , isOnConsent] = mockSync.mock.calls[0];
    expect(connDid).toBe(ANTHROPIC_CONNECTOR_DID);
    expect(isOnConsent('anthropic:infer')).toBe(true);
  });
});

describe('publishAnthropicScopeManifest', () => {
  it('publishes under its own filename and channel', async () => {
    await publishAnthropicScopeManifest('did:owner', ['anthropic:infer']);
    const opts = mockPublish.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.connectorDid).toBe(ANTHROPIC_CONNECTOR_DID);
    expect(opts.channel).toBe('anthropic');
    expect(opts.filename).toBe('anthropic-scope-manifest.md');
  });
});

describe('credential status', () => {
  it('delegates anthropicKeySealed to vaultFieldExists with the per-DID field', async () => {
    existsMock.mockResolvedValueOnce(true);
    expect(await anthropicKeySealed('did:owner')).toBe(true);
    expect(existsMock).toHaveBeenCalledWith('anthropic-api-key:did:owner');
  });

  it('re-exports anthropicKeyPending so the route imports from one place', async () => {
    statusMock.mockResolvedValue('pending-grant');
    expect(await anthropicKeyPending('did:owner')).toBe(true);
  });
});
