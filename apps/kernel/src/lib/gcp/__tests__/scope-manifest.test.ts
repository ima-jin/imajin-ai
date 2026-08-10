import { describe, it, expect, vi } from 'vitest';

// ─── GCP scope-manifest wrapper tests (#1317) ─────────────────────────────────
//
// Tests the GCP-specific layer: descriptor values, constants, and that the
// wrapper functions delegate to scope-manifest-core with the right parameters.
// The core logic (DB queries, consent grant sync, publish orchestration) is
// tested in kernel/__tests__/scope-manifest-core.test.ts.

const { mockBuild, mockFind, mockReadActive, mockSync, mockPublish } = vi.hoisted(() => ({
  mockBuild: vi.fn(() => 'yaml-content'),
  mockFind: vi.fn(async () => null),
  mockReadActive: vi.fn(async () => []),
  mockSync: vi.fn(async () => undefined),
  mockPublish: vi.fn(async () => 'asset_gcp'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => ({
  buildConnectorManifestContent: mockBuild,
  findConnectorManifestAsset: mockFind,
  readActiveConnectorScopes: mockReadActive,
  syncConnectorConsentGrants: mockSync,
  publishConnectorScopeManifest: mockPublish,
}));

const { sealedMock, statusMock } = vi.hoisted(() => ({
  sealedMock: vi.fn().mockResolvedValue(false),
  statusMock: vi.fn().mockResolvedValue('absent'),
}));
vi.mock('../connector', () => ({
  GCP_CONNECTOR_DID: 'did:imajin:gcp-connector',
  gcpKeySealed: sealedMock,
  gcpKeyPending: (did: string) => statusMock(`gcp-api-key:${did}`).then((s: string) => s === 'pending-grant'),
}));

import {
  buildManifestContent,
  findGcpManifestAsset,
  readActiveGcpScopes,
  syncConsentGrants,
  publishGcpScopeManifest,
  gcpKeySealed,
  gcpKeyPending,
  VALID_GCP_SCOPES,
  GCP_SCOPE_DESCRIPTORS,
} from '../scope-manifest';
import { GCP_CONNECTOR_DID } from '../connector';

const STAGE_1_SCOPES = ['gcp:iam:read', 'gcp:vertex:invoke', 'gcp:project:read'];

describe('GCP_SCOPE_DESCRIPTORS', () => {
  /**
   * Stage 1 opens exactly three scopes. Pinning the list here is what makes a
   * fourth a deliberate review decision rather than something that appears
   * because someone widened the vocabulary for an unrelated reason.
   */
  it('exposes the three Stage 1 scopes, in vocabulary order', () => {
    expect(VALID_GCP_SCOPES).toEqual(STAGE_1_SCOPES);
    expect(Object.keys(GCP_SCOPE_DESCRIPTORS)).toEqual(STAGE_1_SCOPES);
  });

  it.each(STAGE_1_SCOPES)('defines %s as owner-only (sensitive, not disclosing others)', (scope) => {
    const r = GCP_SCOPE_DESCRIPTORS[scope].release;
    expect(r.discloses_others).toBe(false);
    expect(r.sensitive).toBe(true);
    expect(r.viewer).toBe(GCP_CONNECTOR_DID);
  });

  it('reaches every scope over the one gcp-api surface', () => {
    for (const scope of STAGE_1_SCOPES) {
      expect(GCP_SCOPE_DESCRIPTORS[scope].surface).toBe('gcp-api');
    }
  });
});

describe('buildManifestContent', () => {
  it('calls buildConnectorManifestContent with GCP DID, channel, descriptors', () => {
    buildManifestContent(['gcp:vertex:invoke']);
    expect(mockBuild).toHaveBeenCalledWith(
      GCP_CONNECTOR_DID, 'gcp', GCP_SCOPE_DESCRIPTORS, ['gcp:vertex:invoke'],
    );
  });
});

describe('findGcpManifestAsset', () => {
  it('calls findConnectorManifestAsset with GCP DID', async () => {
    await findGcpManifestAsset('did:owner');
    expect(mockFind).toHaveBeenCalledWith('did:owner', GCP_CONNECTOR_DID);
  });
});

describe('readActiveGcpScopes', () => {
  it('calls readActiveConnectorScopes with gcp channel and GCP DID', async () => {
    await readActiveGcpScopes('did:owner');
    expect(mockReadActive).toHaveBeenCalledWith('did:owner', 'gcp', GCP_CONNECTOR_DID);
  });
});

describe('syncConsentGrants', () => {
  /**
   * `owner-only` still sits behind a consent barrier, so publishing any of these
   * must record a consent_grants row: unsealing a service-account key is exactly
   * the decision the owner is being asked to make.
   */
  it('records a consent row for every Stage 1 scope', async () => {
    await syncConsentGrants('did:owner', 'asset_x', STAGE_1_SCOPES);
    const [, connDid, , , isOnConsent] = mockSync.mock.calls[0];
    expect(connDid).toBe(GCP_CONNECTOR_DID);
    for (const scope of STAGE_1_SCOPES) {
      expect(isOnConsent(scope)).toBe(true);
    }
  });

  it('fails closed for a scope the GCP connector does not own', async () => {
    await syncConsentGrants('did:owner', 'asset_x', []);
    const [, , , , isOnConsent] = mockSync.mock.calls[0];
    expect(isOnConsent('gemini:infer')).toBe(false);
  });
});

describe('publishGcpScopeManifest', () => {
  it('calls publishConnectorScopeManifest with correct GCP opts', async () => {
    await publishGcpScopeManifest('did:owner', ['gcp:vertex:invoke']);
    const opts = mockPublish.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.connectorDid).toBe(GCP_CONNECTOR_DID);
    expect(opts.channel).toBe('gcp');
    expect(opts.filename).toBe('gcp-scope-manifest.md');
  });
});

describe('gcpKeySealed re-export (#1774)', () => {
  // A local vaultFieldExists-based redefinition here (as before #1774) would
  // shadow the grant-aware fix ./connector already made for #1724, leaving a
  // disconnected key reporting `keySealed: true` forever on this route
  // specifically.
  it('is re-exported from ./connector rather than a local vaultFieldExists redefinition', async () => {
    sealedMock.mockResolvedValueOnce(true);
    expect(await gcpKeySealed('did:owner')).toBe(true);
    expect(sealedMock).toHaveBeenCalledWith('did:owner');
  });
});

describe('gcpKeyPending re-export (#1521)', () => {
  it('is re-exported from scope-manifest.ts so the route can import it from one place', async () => {
    statusMock.mockResolvedValue('pending-grant');
    expect(await gcpKeyPending('did:owner')).toBe(true);
  });
});
