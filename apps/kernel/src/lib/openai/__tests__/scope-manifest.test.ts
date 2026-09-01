/**
 * OpenAI scope-manifest tests (#1927).
 *
 * The wrapper owns nothing but identity, so identity is what is pinned: every
 * delegation into scope-manifest-core must carry the OpenAI connector DID and
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
  readActiveConnectorScopes: vi.fn(async () => ['openai:infer']),
  syncConnectorConsentGrants: vi.fn(async () => undefined),
  publishConnectorScopeManifest: vi.fn(async () => 'asset_1'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

vi.mock('../connector', () => ({
  OPENAI_CONNECTOR_DID: 'did:imajin:openai-connector',
  OPENAI_CHANNEL: 'openai',
  openaiKeySealed: vi.fn(),
  openaiKeyPending: vi.fn(),
}));

import {
  OPENAI_SCOPE_DESCRIPTORS,
  VALID_OPENAI_SCOPES,
  buildManifestContent,
  findOpenaiManifestAsset,
  readActiveOpenaiScopes,
  syncConsentGrants,
  publishOpenaiScopeManifest,
} from '../scope-manifest';

const OWNER = 'did:imajin:farmer';
const DID = 'did:imajin:openai-connector';

beforeEach(() => {
  for (const fn of Object.values(core)) fn.mockClear();
});

describe('derived scope registry', () => {
  it('accepts exactly the scopes the vocabulary gives this connector', () => {
    expect(VALID_OPENAI_SCOPES).toEqual(['openai:infer']);
    expect(Object.keys(OPENAI_SCOPE_DESCRIPTORS)).toEqual(['openai:infer']);
  });
});

describe('every delegation carries the OpenAI identity', () => {
  it('builds manifest content for the openai connector and channel', () => {
    buildManifestContent(['openai:infer']);

    expect(core.buildConnectorManifestContent).toHaveBeenCalledWith(
      DID, 'openai', OPENAI_SCOPE_DESCRIPTORS, ['openai:infer'],
    );
  });

  it('looks the manifest asset up by the openai connector DID', async () => {
    await findOpenaiManifestAsset(OWNER);

    expect(core.findConnectorManifestAsset).toHaveBeenCalledWith(OWNER, DID);
  });

  it('reads active scopes from the openai channel + connector DID', async () => {
    expect(await readActiveOpenaiScopes(OWNER)).toEqual(['openai:infer']);
    expect(core.readActiveConnectorScopes).toHaveBeenCalledWith(OWNER, 'openai', DID);
  });

  it('syncs consent grants against the openai connector DID', async () => {
    await syncConsentGrants(OWNER, 'asset_1', ['openai:infer']);

    const [ownerDid, connectorDid, assetId, scopes] = core.syncConnectorConsentGrants.mock.calls[0];
    expect([ownerDid, connectorDid, assetId, scopes]).toEqual([OWNER, DID, 'asset_1', ['openai:infer']]);
  });

  /**
   * `openai:infer` is owner-only under the #1196 2×2, so publishing it must
   * record a consent row — the same treatment `gemini:infer` / `xai:infer`
   * get. `isOnConsent` is passed as a predicate, so it is asserted by calling
   * it rather than by identity.
   */
  it('publishes under the openai identity and records consent for openai:infer', async () => {
    expect(await publishOpenaiScopeManifest(OWNER, ['openai:infer'])).toBe('asset_1');

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
      channel: 'openai',
      filename: 'openai-scope-manifest.md',
    });
    expect(opts.isOnConsent('openai:infer')).toBe(true);
    // Fail-closed: a scope this connector does not own never records consent.
    expect(opts.isOnConsent('gemini:infer')).toBe(false);
  });
});
