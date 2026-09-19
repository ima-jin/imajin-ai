/**
 * TypeSafe.ai scope-manifest tests (#2197).
 *
 * Pins that every delegation into scope-manifest-core carries the TypeSafe
 * connector DID and channel -- a wrong DID here is silent: it publishes a
 * manifest, and projects channel_links, under some OTHER connector.
 *
 * Does NOT reuse `describeScopeManifestIdentityContract`
 * (`brain-connector-contract.ts`): that shared contract assumes its scope is
 * owner-only/on-consent (true for every `*:infer` scope) and asserts
 * `isOnConsent(scope) === true`. `typesafe:decide` is deliberately SELF_ONLY
 * -> `silent` (matching `quickbooks:read`, per the issue's design revision),
 * so it must assert the OPPOSITE: publishing it records NO consent row.
 */
import { vi, it, expect, describe, beforeEach } from 'vitest';

const core = vi.hoisted(() => ({
  buildConnectorManifestContent: vi.fn(() => '---\nkind: scope-manifest\n---\n'),
  findConnectorManifestAsset: vi.fn(async () => null),
  readActiveConnectorScopes: vi.fn(async () => ['typesafe:decide']),
  syncConnectorConsentGrants: vi.fn(async () => undefined),
  publishConnectorScopeManifest: vi.fn(async () => 'asset_1'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

vi.mock('../connector', () => ({
  TYPESAFE_CONNECTOR_DID: 'did:imajin:typesafe-connector',
  TYPESAFE_CHANNEL: 'typesafe',
  typesafeKeySealed: vi.fn(),
  typesafeKeyPending: vi.fn(),
}));

import {
  TYPESAFE_SCOPE_DESCRIPTORS,
  VALID_TYPESAFE_SCOPES,
  buildManifestContent,
  findTypesafeManifestAsset,
  readActiveTypesafeScopes,
  syncConsentGrants,
  publishTypesafeScopeManifest,
  typesafeKeySealed,
  typesafeKeyPending,
} from '../scope-manifest';
import { typesafeKeySealed as connectorKeySealed, typesafeKeyPending as connectorKeyPending } from '../connector';

const OWNER = 'did:imajin:farmer';
const CONNECTOR_DID = 'did:imajin:typesafe-connector';
const CHANNEL = 'typesafe';
const SCOPE = 'typesafe:decide';

beforeEach(() => {
  for (const fn of Object.values(core)) fn.mockClear();
});

it('re-exports typesafeKeySealed/typesafeKeyPending from ./connector rather than redefining them locally', () => {
  expect(typesafeKeySealed).toBe(connectorKeySealed);
  expect(typesafeKeyPending).toBe(connectorKeyPending);
});

describe('derived scope registry', () => {
  it('accepts exactly the one scope the vocabulary gives this connector', () => {
    expect(VALID_TYPESAFE_SCOPES).toEqual([SCOPE]);
    expect(Object.keys(TYPESAFE_SCOPE_DESCRIPTORS)).toEqual([SCOPE]);
  });
});

describe('every delegation carries the TypeSafe.ai identity', () => {
  it('builds manifest content for the typesafe connector and channel', () => {
    buildManifestContent([SCOPE]);

    expect(core.buildConnectorManifestContent).toHaveBeenCalledWith(
      CONNECTOR_DID, CHANNEL, TYPESAFE_SCOPE_DESCRIPTORS, [SCOPE],
    );
  });

  it('looks the manifest asset up by the typesafe connector DID', async () => {
    await findTypesafeManifestAsset(OWNER);

    expect(core.findConnectorManifestAsset).toHaveBeenCalledWith(OWNER, CONNECTOR_DID);
  });

  it('reads active scopes from the typesafe channel + connector DID', async () => {
    expect(await readActiveTypesafeScopes(OWNER)).toEqual([SCOPE]);
    expect(core.readActiveConnectorScopes).toHaveBeenCalledWith(OWNER, CHANNEL, CONNECTOR_DID);
  });

  it('syncs consent grants against the typesafe connector DID', async () => {
    await syncConsentGrants(OWNER, 'asset_1', [SCOPE]);

    const [ownerDid, gotConnectorDid, assetId, scopes] = core.syncConnectorConsentGrants.mock.calls[0];
    expect([ownerDid, gotConnectorDid, assetId, scopes]).toEqual([OWNER, CONNECTOR_DID, 'asset_1', [SCOPE]]);
  });

  /**
   * `typesafe:decide` is SELF_ONLY -> `silent` under the #1196 2x2, unlike
   * every `*:infer` scope (owner-only). Publishing it must NOT record a
   * consent row -- the opposite assertion `describeScopeManifestIdentityContract`
   * makes for the brain connectors.
   */
  it('publishes under the typesafe identity and records NO consent for typesafe:decide (silent tier)', async () => {
    expect(await publishTypesafeScopeManifest(OWNER, [SCOPE])).toBe('asset_1');

    const [opts] = core.publishConnectorScopeManifest.mock.calls[0] as [{
      ownerDid: string;
      connectorDid: string;
      channel: string;
      filename: string;
      isOnConsent: (s: string) => boolean;
    }];
    expect(opts).toMatchObject({ ownerDid: OWNER, connectorDid: CONNECTOR_DID, channel: CHANNEL, filename: 'typesafe-scope-manifest.md' });
    expect(opts.isOnConsent(SCOPE)).toBe(false);
    // Fail-closed either way: a scope this connector does not own never records consent.
    expect(opts.isOnConsent('not-this-connector:infer')).toBe(false);
  });
});
