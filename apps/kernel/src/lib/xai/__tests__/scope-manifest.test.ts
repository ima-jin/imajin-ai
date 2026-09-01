/**
 * xAI scope-manifest tests (#1924).
 *
 * The wrapper owns nothing but identity, so identity is what is pinned: every
 * delegation into scope-manifest-core must carry the xAI connector DID and
 * channel. A wrong DID here does not fail — it publishes a manifest, writes
 * consent rows, and projects channel_links under some OTHER connector, which
 * then silently satisfies (or fails) that connector's grant gate instead.
 *
 * The descriptor projection itself is covered by the #1253 drift guard in
 * `src/lib/kernel/__tests__/scope-vocabulary-projection.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const OWNER = 'did:imajin:farmer';
const DID = 'did:imajin:xai-connector';

beforeEach(() => {
  for (const fn of Object.values(core)) fn.mockClear();
});

describe('derived scope registry', () => {
  it('accepts exactly the scopes the vocabulary gives this connector', () => {
    expect(VALID_XAI_SCOPES).toEqual(['xai:infer']);
    expect(Object.keys(XAI_SCOPE_DESCRIPTORS)).toEqual(['xai:infer']);
  });
});

describe('every delegation carries the xAI identity', () => {
  it('builds manifest content for the xai connector and channel', () => {
    buildManifestContent(['xai:infer']);

    expect(core.buildConnectorManifestContent).toHaveBeenCalledWith(
      DID, 'xai', XAI_SCOPE_DESCRIPTORS, ['xai:infer'],
    );
  });

  it('looks the manifest asset up by the xai connector DID', async () => {
    await findXaiManifestAsset(OWNER);

    expect(core.findConnectorManifestAsset).toHaveBeenCalledWith(OWNER, DID);
  });

  it('reads active scopes from the xai channel + connector DID', async () => {
    expect(await readActiveXaiScopes(OWNER)).toEqual(['xai:infer']);
    expect(core.readActiveConnectorScopes).toHaveBeenCalledWith(OWNER, 'xai', DID);
  });

  it('syncs consent grants against the xai connector DID', async () => {
    await syncConsentGrants(OWNER, 'asset_1', ['xai:infer']);

    const [ownerDid, connectorDid, assetId, scopes] = core.syncConnectorConsentGrants.mock.calls[0];
    expect([ownerDid, connectorDid, assetId, scopes]).toEqual([OWNER, DID, 'asset_1', ['xai:infer']]);
  });

  /**
   * `xai:infer` is owner-only under the #1196 2×2, so publishing it must record
   * a consent row — the same treatment `gemini:infer` gets. `isOnConsent` is
   * passed as a predicate, so it is asserted by calling it rather than by
   * identity.
   */
  it('publishes under the xai identity and records consent for xai:infer', async () => {
    expect(await publishXaiScopeManifest(OWNER, ['xai:infer'])).toBe('asset_1');

    const [opts] = core.publishConnectorScopeManifest.mock.calls[0] as [{
      ownerDid: string;
      connectorDid: string;
      channel: string;
      filename: string;
      isOnConsent: (s: string) => boolean;
    }];
    expect(opts).toMatchObject({
      ownerDid: OWNER,
      connectorDid: DID,
      channel: 'xai',
      filename: 'xai-scope-manifest.md',
    });
    expect(opts.isOnConsent('xai:infer')).toBe(true);
    // Fail-closed: a scope this connector does not own never records consent.
    expect(opts.isOnConsent('gemini:infer')).toBe(false);
  });
});
