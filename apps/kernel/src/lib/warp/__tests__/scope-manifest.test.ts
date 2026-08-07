/**
 * Tests for the Warp scope-manifest wrapper and its route wiring (#1428).
 *
 * `scope-manifest-core` is mocked: the generic DB and publish orchestration is
 * tested with the other connectors. What is Warp-specific — and what these pin —
 * is that the wrapper passes the *Warp* identity (connector DID, channel,
 * manifest filename) into every core call, and derives its scope set from the
 * vocabulary rather than a hand-written list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { core } = vi.hoisted(() => ({
  core: {
    buildConnectorManifestContent: vi.fn(() => '---\nmanifest\n---'),
    findConnectorManifestAsset: vi.fn(),
    readActiveConnectorScopes: vi.fn(),
    syncConnectorConsentGrants: vi.fn(),
    publishConnectorScopeManifest: vi.fn(),
  },
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

// The connector pulls in the vault and the DB; only its constants matter here.
vi.mock('../connector', () => ({
  WARP_CONNECTOR_DID: 'did:imajin:warp-connector',
  WARP_CHANNEL: 'warp',
  warpKeySealed: vi.fn(),
}));

import {
  WARP_SCOPE_DESCRIPTORS,
  VALID_WARP_SCOPES,
  buildManifestContent,
  findWarpManifestAsset,
  readActiveWarpScopes,
  syncConsentGrants,
  publishWarpScopeManifest,
} from '../scope-manifest';

const OWNER_DID = 'did:imajin:veteze';
const WARP_DID = 'did:imajin:warp-connector';

beforeEach(() => {
  vi.clearAllMocks();
  core.buildConnectorManifestContent.mockReturnValue('---\nmanifest\n---');
  core.findConnectorManifestAsset.mockResolvedValue({ id: 'asset_1' });
  core.readActiveConnectorScopes.mockResolvedValue(['warp:dispatch']);
  core.publishConnectorScopeManifest.mockResolvedValue('asset_1');
});

// ─── Derived scope set ───────────────────────────────────────────────────────

describe('scope set is derived from the vocabulary', () => {
  /**
   * One scope, since #1679 moved `discovery:read` to the MCP connector: this
   * connector's validator now accepts exactly what its sealed Agent key can pay
   * for. A credential-free read has no business being POSTable here — the card
   * that publishes this manifest asks for the key first.
   */
  it('accepts exactly the one Warp scope in the POST validator', () => {
    expect(VALID_WARP_SCOPES).toEqual(['warp:dispatch']);
  });

  it('describes warp:dispatch as an owner-only cloud-agent scope in the manifest', () => {
    expect(WARP_SCOPE_DESCRIPTORS['warp:dispatch']).toEqual({
      verb: 'dispatch',
      surface: 'cloud-agents',
      label: 'Dispatch Warp cloud agents under your own credential',
      release: { discloses_others: false, sensitive: true, viewer: WARP_DID },
    });
  });

  /**
   * #1679: `discovery:read` is gone from this manifest. Leaving it here would
   * keep writing a `warp` channel_links row for a scope the MCP gate no longer
   * reads — an active grant that grants nothing.
   */
  it('no longer describes discovery:read', () => {
    expect(WARP_SCOPE_DESCRIPTORS).not.toHaveProperty('discovery:read');
  });
});

// ─── Delegation to core ──────────────────────────────────────────────────────

describe('every core call carries the Warp identity', () => {
  it('builds manifest content for the warp connector and channel', () => {
    buildManifestContent(['warp:dispatch']);

    expect(core.buildConnectorManifestContent).toHaveBeenCalledWith(
      WARP_DID,
      'warp',
      WARP_SCOPE_DESCRIPTORS,
      ['warp:dispatch'],
    );
  });

  it('looks up the manifest asset by owner and connector DID', async () => {
    await expect(findWarpManifestAsset(OWNER_DID)).resolves.toEqual({ id: 'asset_1' });
    expect(core.findConnectorManifestAsset).toHaveBeenCalledWith(OWNER_DID, WARP_DID);
  });

  it('reads active scopes from the warp channel', async () => {
    await expect(readActiveWarpScopes(OWNER_DID)).resolves.toEqual(['warp:dispatch']);
    expect(core.readActiveConnectorScopes).toHaveBeenCalledWith(OWNER_DID, 'warp', WARP_DID);
  });

  it('publishes under a warp-specific manifest filename', async () => {
    await publishWarpScopeManifest(OWNER_DID, ['warp:dispatch']);

    const [opts] = core.publishConnectorScopeManifest.mock.calls[0] as [
      { connectorDid: string; channel: string; filename: string; isOnConsent: (s: string) => boolean },
    ];
    expect(opts.connectorDid).toBe(WARP_DID);
    expect(opts.channel).toBe('warp');
    expect(opts.filename).toBe('warp-scope-manifest.md');
    // owner-only sits behind a consent barrier, so a grant must be recorded.
    expect(opts.isOnConsent('warp:dispatch')).toBe(true);
    // A scope this connector does not own is never consentable through it.
    expect(opts.isOnConsent('discovery:read')).toBe(false);
  });

  it('records a consent row when the owner grants warp:dispatch', async () => {
    await syncConsentGrants(OWNER_DID, 'asset_1', ['warp:dispatch']);

    const call = core.syncConnectorConsentGrants.mock.calls[0] as [
      string,
      string,
      string,
      readonly string[],
      (s: string) => boolean,
    ];
    expect(call[0]).toBe(OWNER_DID);
    expect(call[1]).toBe(WARP_DID);
    expect(call[4]('warp:dispatch')).toBe(true);
    // A scope this connector does not own must never be treated as consentable.
    expect(call[4]('media:read')).toBe(false);
  });
});
