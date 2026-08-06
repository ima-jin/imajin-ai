/**
 * Tests for the Warp connector's custody wiring (#1428).
 *
 * The vault and DB are mocked, so these assert the *wiring* that gives the issue
 * its properties — per-DID field isolation, the connector DID as grantee, the
 * `warp:dispatch` authority gate, and revoke-kills-dispatch — without running
 * crypto or touching a database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sealGrantMock, loadGranteeMock, revokeGrantMock, existsMock, whereMock } = vi.hoisted(() => ({
  sealGrantMock: vi.fn(),
  loadGranteeMock: vi.fn(),
  revokeGrantMock: vi.fn(),
  existsMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({
  sealAndGrantStaticSecret: sealGrantMock,
  loadAndUnsealByGrantee: loadGranteeMock,
  revokeStaticSecretGrant: revokeGrantMock,
  vaultFieldExists: existsMock,
}));

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: whereMock }) }) },
  channelLinks: {
    channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes',
  },
}));

import {
  warpConnector,
  warpKeyField,
  sealWarpAgentKey,
  requireAgentKey,
  requireDiscoveryGrant,
  revokeWarpAgentKeyGrant,
  WARP_CONNECTOR_DID,
  WARP_CHANNEL,
  WARP_DISCOVERY_SCOPE,
  WARP_DISPATCH_SCOPE,
} from '../connector';

const PRINCIPAL = 'did:imajin:veteze';
const OTHER = 'did:imajin:chris';
const AGENT_KEY = 'warp-agent-key-SUPER-SECRET-VALUE';

/** An active channel_links row carrying `scopes`. */
function withScopes(scopes: string[]) {
  whereMock.mockResolvedValue([{ scopes }]);
}

beforeEach(() => {
  sealGrantMock.mockReset().mockResolvedValue({ entry: {}, grantId: 'vdg_warp' });
  loadGranteeMock.mockReset().mockResolvedValue(undefined);
  revokeGrantMock.mockReset().mockResolvedValue(false);
  existsMock.mockReset().mockResolvedValue(false);
  whereMock.mockReset().mockResolvedValue([]);
});

// ── Identity ──────────────────────────────────────────────────────────────────

describe('connector identity', () => {
  it('uses the warp connector DID and channel declared in the vocabulary', () => {
    expect(WARP_CONNECTOR_DID).toBe('did:imajin:warp-connector');
    expect(WARP_CHANNEL).toBe('warp');
    expect(WARP_DISPATCH_SCOPE).toBe('warp:dispatch');
    expect(WARP_DISCOVERY_SCOPE).toBe('discovery:read');
  });
});

// ── Per-DID isolation ─────────────────────────────────────────────────────────

describe('per-DID field isolation', () => {
  it('encodes the principal DID in the vault field name', () => {
    expect(warpKeyField(PRINCIPAL)).toBe(`warp-agent-key:${PRINCIPAL}`);
  });

  it('gives different DIDs structurally different fields, so cross-DID reads cannot happen', () => {
    expect(warpKeyField(PRINCIPAL)).not.toBe(warpKeyField(OTHER));
  });
});

// ── v2 delegation-grant custody ───────────────────────────────────────────────

describe('sealing goes through the v2 delegation-grant path', () => {
  it('seals under the caller DID as subject and the connector DID as grantee', async () => {
    await sealWarpAgentKey(PRINCIPAL, AGENT_KEY);

    const [field, plaintext, opts] = sealGrantMock.mock.calls[0] as [
      string,
      string,
      { principalDid: string; granteeDid: string },
    ];
    expect(field).toBe(`warp-agent-key:${PRINCIPAL}`);
    expect(plaintext).toBe(AGENT_KEY);
    expect(opts.principalDid).toBe(PRINCIPAL);
    expect(opts.granteeDid).toBe(WARP_CONNECTOR_DID);
  });
});

// ── Authority gate (#1218) ────────────────────────────────────────────────────

describe('requireAgentKey is authority-gated', () => {
  it('refuses when no active channel_links row carries warp:dispatch', async () => {
    await expect(requireAgentKey(PRINCIPAL)).rejects.toThrow(/warp_no_grant/);
    expect(loadGranteeMock).not.toHaveBeenCalled();
  });

  it('refuses when the row carries some other scope', async () => {
    withScopes(['gemini:infer']);
    await expect(requireAgentKey(PRINCIPAL)).rejects.toThrow(/warp_no_grant/);
  });

  it('unwraps the key when the grant and the sealed secret are both present', async () => {
    withScopes([WARP_DISPATCH_SCOPE]);
    loadGranteeMock.mockResolvedValue(AGENT_KEY);

    expect(await requireAgentKey(PRINCIPAL)).toBe(AGENT_KEY);

    const [field, granteeDid] = loadGranteeMock.mock.calls[0] as [string, string];
    expect(field).toBe(`warp-agent-key:${PRINCIPAL}`);
    expect(granteeDid).toBe(WARP_CONNECTOR_DID);
  });
});

// ── Discovery gate (#1636) ────────────────────────────────────────────────

describe('requireDiscoveryGrant is authority-gated but credential-free', () => {
  it('refuses when no active channel_links row carries discovery:read', async () => {
    await expect(requireDiscoveryGrant(PRINCIPAL)).rejects.toThrow(/warp_no_grant/);
  });

  it('passes on an active discovery:read row without touching the vault', async () => {
    withScopes([WARP_DISCOVERY_SCOPE]);

    await expect(requireDiscoveryGrant(PRINCIPAL)).resolves.toBeUndefined();
    // No sealed key is involved, so no unseal may be attempted — a read of the
    // node's own specs must never reach for the caller's Warp Agent key.
    expect(loadGranteeMock).not.toHaveBeenCalled();
  });

  /**
   * The two directions that make the split worth having: a DID that can dispatch
   * cannot implicitly read, and a DID that can read cannot implicitly dispatch.
   */
  it('is not satisfied by warp:dispatch alone', async () => {
    withScopes([WARP_DISPATCH_SCOPE]);
    await expect(requireDiscoveryGrant(PRINCIPAL)).rejects.toThrow(/warp_no_grant/);
  });

  it('does not itself satisfy the dispatch gate', async () => {
    withScopes([WARP_DISCOVERY_SCOPE]);
    await expect(requireAgentKey(PRINCIPAL)).rejects.toThrow(/warp_no_grant/);
    expect(loadGranteeMock).not.toHaveBeenCalled();
  });
});

// ── Revoke kills dispatch, without rotating the key ───────────────────────────

describe('revocation', () => {
  it('revokes the grant for (field, connectorDid)', async () => {
    revokeGrantMock.mockResolvedValue(true);
    await revokeWarpAgentKeyGrant(PRINCIPAL);

    const [field, granteeDid] = revokeGrantMock.mock.calls[0] as [string, string];
    expect(field).toBe(`warp-agent-key:${PRINCIPAL}`);
    expect(granteeDid).toBe(WARP_CONNECTOR_DID);
  });

  it('kills dispatch immediately: the unseal fails closed with the ciphertext untouched', async () => {
    withScopes([WARP_DISPATCH_SCOPE]);
    loadGranteeMock.mockResolvedValue(AGENT_KEY);
    expect(await requireAgentKey(PRINCIPAL)).toBe(AGENT_KEY);

    // Revoking erases the wrapped field key, so loadAndUnsealByGrantee finds no
    // active grant and returns undefined — no key rotation, no re-seal.
    revokeGrantMock.mockResolvedValue(true);
    await revokeWarpAgentKeyGrant(PRINCIPAL);
    loadGranteeMock.mockResolvedValue(undefined);

    await expect(requireAgentKey(PRINCIPAL)).rejects.toThrow(/warp_no_secret/);
  });
});

// ── Status ────────────────────────────────────────────────────────────────────

describe('secretSealed', () => {
  it('reports on the per-DID field without unsealing anything', async () => {
    existsMock.mockResolvedValue(true);
    expect(await warpConnector.secretSealed(PRINCIPAL)).toBe(true);
    expect(existsMock).toHaveBeenCalledWith(`warp-agent-key:${PRINCIPAL}`);
    expect(loadGranteeMock).not.toHaveBeenCalled();
  });
});
