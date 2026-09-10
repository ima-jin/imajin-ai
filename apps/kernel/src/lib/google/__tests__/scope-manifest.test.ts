import { describe, it, expect, vi } from 'vitest';

// ─── Google scope-manifest wrapper tests (#2144) ────────────────────────────
//
// Tests the Google-specific layer: descriptor values, constants, and that the
// wrapper functions delegate to scope-manifest-core with the right parameters.
// The core logic (DB queries, consent grant sync, publish orchestration) is
// tested in kernel/__tests__/scope-manifest-core.test.ts.

const { mockBuild, mockFind, mockReadActive, mockSync, mockPublish } = vi.hoisted(() => ({
  mockBuild: vi.fn(() => 'yaml-content'),
  mockFind: vi.fn(async () => null),
  mockReadActive: vi.fn(async () => []),
  mockSync: vi.fn(async () => undefined),
  mockPublish: vi.fn(async () => 'asset_google'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => ({
  buildConnectorManifestContent: mockBuild,
  findConnectorManifestAsset: mockFind,
  readActiveConnectorScopes: mockReadActive,
  syncConnectorConsentGrants: mockSync,
  publishConnectorScopeManifest: mockPublish,
}));

// Avoids loading the real connector.ts's db/bus/vault/connector-oauth import
// graph — this suite only needs the connector DID constant.
vi.mock('../connector', () => ({ GOOGLE_CONNECTOR_DID: 'did:imajin:google-connector' }));
vi.mock('../constants', () => ({ GOOGLE_CONNECTOR_DID: 'did:imajin:google-connector' }));

import {
  buildManifestContent,
  findGoogleManifestAsset,
  readActiveGoogleScopes,
  syncConsentGrants,
  publishGoogleScopeManifest,
  VALID_GOOGLE_SCOPES,
  GOOGLE_SCOPE_DESCRIPTORS,
} from '../scope-manifest';
import { GOOGLE_CONNECTOR_DID } from '../connector';

const V1_SCOPES = [
  'google:gmail:read', 'google:gmail:send',
  'google:calendar:read', 'google:calendar:write',
  'google:drive:read', 'google:meet:records',
];

describe('GOOGLE_SCOPE_DESCRIPTORS (#2144)', () => {
  it('exposes exactly the six v1 scopes, in vocabulary order', () => {
    expect(VALID_GOOGLE_SCOPES).toEqual(V1_SCOPES);
    expect(Object.keys(GOOGLE_SCOPE_DESCRIPTORS)).toEqual(V1_SCOPES);
  });

  it.each(V1_SCOPES)('defines %s as owner-only (sensitive, not disclosing others)', (scope) => {
    const r = GOOGLE_SCOPE_DESCRIPTORS[scope].release;
    expect(r.discloses_others).toBe(false);
    expect(r.sensitive).toBe(true);
    expect(r.viewer).toBe(GOOGLE_CONNECTOR_DID);
  });

  it('reaches every scope over the one google-api surface', () => {
    for (const scope of V1_SCOPES) {
      expect(GOOGLE_SCOPE_DESCRIPTORS[scope].surface).toBe('google-api');
    }
  });

  it('does not declare any v2 scope (contacts, admin, sheets)', () => {
    expect(VALID_GOOGLE_SCOPES).not.toContain('google:contacts:read');
    expect(VALID_GOOGLE_SCOPES).not.toContain('google:admin:reports');
    expect(VALID_GOOGLE_SCOPES).not.toContain('google:sheets:write');
  });
});

describe('buildManifestContent', () => {
  it('calls buildConnectorManifestContent with Google DID, channel, descriptors', () => {
    buildManifestContent(['google:gmail:read']);
    expect(mockBuild).toHaveBeenCalledWith(
      GOOGLE_CONNECTOR_DID, 'google', GOOGLE_SCOPE_DESCRIPTORS, ['google:gmail:read'],
    );
  });
});

describe('findGoogleManifestAsset', () => {
  it('calls findConnectorManifestAsset with the Google DID', async () => {
    await findGoogleManifestAsset('did:owner');
    expect(mockFind).toHaveBeenCalledWith('did:owner', GOOGLE_CONNECTOR_DID);
  });
});

describe('readActiveGoogleScopes', () => {
  it('calls readActiveConnectorScopes with the google channel and DID', async () => {
    await readActiveGoogleScopes('did:owner');
    expect(mockReadActive).toHaveBeenCalledWith('did:owner', 'google', GOOGLE_CONNECTOR_DID);
  });
});

describe('syncConsentGrants', () => {
  /**
   * `owner-only` still sits behind a consent barrier, so publishing any of
   * these must record a consent_grants row: unsealing the refresh token is
   * exactly the decision the owner is being asked to make.
   */
  it('records a consent row for every v1 scope', async () => {
    await syncConsentGrants('did:owner', 'asset_x', V1_SCOPES);
    const [, connDid, , , isOnConsent] = mockSync.mock.calls[0];
    expect(connDid).toBe(GOOGLE_CONNECTOR_DID);
    for (const scope of V1_SCOPES) {
      expect(isOnConsent(scope)).toBe(true);
    }
  });

  it('fails closed for a scope the Google connector does not own', async () => {
    await syncConsentGrants('did:owner', 'asset_x', []);
    const [, , , , isOnConsent] = mockSync.mock.calls[0];
    expect(isOnConsent('gemini:infer')).toBe(false);
  });
});

describe('publishGoogleScopeManifest', () => {
  it('calls publishConnectorScopeManifest with correct Google opts', async () => {
    await publishGoogleScopeManifest('did:owner', ['google:gmail:read']);
    const opts = mockPublish.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.connectorDid).toBe(GOOGLE_CONNECTOR_DID);
    expect(opts.channel).toBe('google');
    expect(opts.filename).toBe('google-scope-manifest.md');
  });
});
