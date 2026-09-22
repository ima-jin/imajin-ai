/**
 * Unit tests for `executeVaultApproval` (#2247) — the bridge that turns an
 * approved `source: 'vault'` operator-approval card into the actual vault
 * mutation (mint/grant/rotate/revoke), and the stub for 'vault:claim'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OperatorApprovalCard } from '../../notify/operator-approvals-service';

const {
  mockMintKeypair,
  mockEmitMintedEvents,
  mockRevokeMintedKey,
  mockEmitRevokedEvents,
  mockGrantExistingMintedKey,
  mockEmitGrantEvents,
  mockGetMintedKeyByDid,
  mockRevokeStaticSecretGrant,
} = vi.hoisted(() => ({
  mockMintKeypair: vi.fn(),
  mockEmitMintedEvents: vi.fn(),
  mockRevokeMintedKey: vi.fn(),
  mockEmitRevokedEvents: vi.fn(),
  mockGrantExistingMintedKey: vi.fn(),
  mockEmitGrantEvents: vi.fn(),
  mockGetMintedKeyByDid: vi.fn(),
  mockRevokeStaticSecretGrant: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../mint', () => ({
  mintKeypair: mockMintKeypair,
  emitMintedEvents: mockEmitMintedEvents,
  revokeMintedKey: mockRevokeMintedKey,
  emitRevokedEvents: mockEmitRevokedEvents,
}));

vi.mock('../grant', () => ({
  grantExistingMintedKey: mockGrantExistingMintedKey,
  emitGrantEvents: mockEmitGrantEvents,
}));

vi.mock('../key-cards', () => ({
  getMintedKeyByDid: mockGetMintedKeyByDid,
}));

vi.mock('../index', () => ({
  revokeStaticSecretGrant: mockRevokeStaticSecretGrant,
}));

import { executeVaultApproval } from '../approvals-execution.js';

function card(overrides: Partial<OperatorApprovalCard> = {}): OperatorApprovalCard {
  return {
    proposalId: 'vprop_1',
    operatorDid: 'did:imajin:operator',
    source: 'vault',
    kind: 'vault:mint',
    summary: 'test',
    keysTouched: [],
    detail: {},
    contentHash: 'hash',
    status: 'approved',
    decision: { decidedBy: 'did:imajin:operator', decidedAt: '2026-01-01T00:00:00.000Z' },
    outcome: null,
    appliedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeVaultApproval — vault:mint', () => {
  it('calls mintKeypair + emitMintedEvents with the proposal detail', async () => {
    mockMintKeypair.mockResolvedValue({ mintId: 'vmk_1', did: 'did:imajin:new', publicKey: 'pk', field: 'f', grantId: 'vdg_1', requestId: null });

    const result = await executeVaultApproval(card({
      kind: 'vault:mint',
      detail: { purpose: 'corpus-identity', requesterDid: 'did:imajin:corpus-bootstrap' },
    }));

    expect(result.ok).toBe(true);
    expect(mockMintKeypair).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'corpus-identity',
      requesterDid: 'did:imajin:corpus-bootstrap',
    }));
    expect(mockEmitMintedEvents).toHaveBeenCalledTimes(1);
  });

  it('fails without calling mintKeypair when purpose/requesterDid are missing', async () => {
    const result = await executeVaultApproval(card({ kind: 'vault:mint', detail: {} }));

    expect(result.ok).toBe(false);
    expect(mockMintKeypair).not.toHaveBeenCalled();
  });
});

describe('executeVaultApproval — vault:grant', () => {
  it('calls grantExistingMintedKey + emitGrantEvents on success', async () => {
    mockGrantExistingMintedKey.mockResolvedValue({ status: 'ok', grantId: 'vdg_new' });
    mockGetMintedKeyByDid.mockResolvedValue({ field: 'vault-minted-key:did:imajin:x' });

    const result = await executeVaultApproval(card({
      kind: 'vault:grant',
      detail: { did: 'did:imajin:x', grantedTo: 'did:imajin:prod-corpus' },
    }));

    expect(result.ok).toBe(true);
    expect(mockGrantExistingMintedKey).toHaveBeenCalledWith(expect.objectContaining({
      did: 'did:imajin:x',
      grantedTo: 'did:imajin:prod-corpus',
    }));
    expect(mockEmitGrantEvents).toHaveBeenCalledTimes(1);
  });

  it('fails when did/grantedTo are missing', async () => {
    const result = await executeVaultApproval(card({ kind: 'vault:grant', detail: {} }));

    expect(result.ok).toBe(false);
    expect(mockGrantExistingMintedKey).not.toHaveBeenCalled();
  });

  it('surfaces a non-ok grantExistingMintedKey outcome as a failure', async () => {
    mockGrantExistingMintedKey.mockResolvedValue({ status: 'tier1_unsupported' });

    const result = await executeVaultApproval(card({
      kind: 'vault:grant',
      detail: { did: 'did:imajin:x', grantedTo: 'did:imajin:prod-corpus' },
    }));

    expect(result.ok).toBe(false);
    expect(mockEmitGrantEvents).not.toHaveBeenCalled();
  });
});

describe('executeVaultApproval — vault:rotate', () => {
  it("mints a replacement for the OLD key's consumer, then revokes the old key", async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ purpose: 'corpus-identity', requestedBy: 'did:imajin:corpus-bootstrap' });
    mockMintKeypair.mockResolvedValue({ mintId: 'vmk_2', did: 'did:imajin:new', publicKey: 'pk', field: 'f', grantId: 'vdg_2', requestId: null });
    mockRevokeMintedKey.mockResolvedValue({ status: 'revoked', record: { id: 'vmk_1', did: 'did:imajin:old', publicKey: 'pk-old' } });

    const result = await executeVaultApproval(card({ kind: 'vault:rotate', detail: { did: 'did:imajin:old' } }));

    expect(result.ok).toBe(true);
    expect(mockMintKeypair).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'corpus-identity',
      requesterDid: 'did:imajin:corpus-bootstrap',
    }));
    expect(mockRevokeMintedKey).toHaveBeenCalledWith({ did: 'did:imajin:old', revokedBy: 'did:imajin:operator' });
    expect(mockEmitRevokedEvents).toHaveBeenCalledTimes(1);
  });

  it('fails when the old did is not a known minted key', async () => {
    mockGetMintedKeyByDid.mockResolvedValue(undefined);

    const result = await executeVaultApproval(card({ kind: 'vault:rotate', detail: { did: 'did:imajin:unknown' } }));

    expect(result.ok).toBe(false);
    expect(mockMintKeypair).not.toHaveBeenCalled();
  });
});

describe('executeVaultApproval — vault:revoke', () => {
  it('tier withdraw calls revokeStaticSecretGrant only, never the full tombstone', async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ field: 'vault-minted-key:did:imajin:x', requestedBy: 'did:imajin:corpus-bootstrap' });

    const result = await executeVaultApproval(card({ kind: 'vault:revoke', detail: { did: 'did:imajin:x', tier: 'withdraw' } }));

    expect(result.ok).toBe(true);
    expect(mockRevokeStaticSecretGrant).toHaveBeenCalledWith('vault-minted-key:did:imajin:x', 'did:imajin:corpus-bootstrap');
    expect(mockRevokeMintedKey).not.toHaveBeenCalled();
  });

  it.each(['tombstone', 'destroy'])('tier %s calls the full revokeMintedKey tombstone', async (tier) => {
    mockGetMintedKeyByDid.mockResolvedValue({ field: 'vault-minted-key:did:imajin:x', requestedBy: 'did:imajin:corpus-bootstrap' });
    mockRevokeMintedKey.mockResolvedValue({ status: 'revoked', record: { id: 'vmk_1', did: 'did:imajin:x', publicKey: 'pk' } });

    const result = await executeVaultApproval(card({ kind: 'vault:revoke', detail: { did: 'did:imajin:x', tier } }));

    expect(result.ok).toBe(true);
    expect(mockRevokeMintedKey).toHaveBeenCalledWith({ did: 'did:imajin:x', revokedBy: 'did:imajin:operator' });
    expect(mockEmitRevokedEvents).toHaveBeenCalledTimes(1);
  });

  it('fails when the did is unknown', async () => {
    mockGetMintedKeyByDid.mockResolvedValue(undefined);

    const result = await executeVaultApproval(card({ kind: 'vault:revoke', detail: { did: 'did:imajin:unknown' } }));

    expect(result.ok).toBe(false);
  });

  it('defaults to withdraw when no tier is supplied', async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ field: 'vault-minted-key:did:imajin:x', requestedBy: 'did:imajin:corpus-bootstrap' });

    await executeVaultApproval(card({ kind: 'vault:revoke', detail: { did: 'did:imajin:x' } }));

    expect(mockRevokeStaticSecretGrant).toHaveBeenCalledTimes(1);
    expect(mockRevokeMintedKey).not.toHaveBeenCalled();
  });
});

describe('executeVaultApproval — vault:claim (stub pending #2243)', () => {
  it('always reports a stubbed failure, never executing anything', async () => {
    const result = await executeVaultApproval(card({ kind: 'vault:claim', detail: {} }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/#2243/);
    expect(mockMintKeypair).not.toHaveBeenCalled();
    expect(mockGrantExistingMintedKey).not.toHaveBeenCalled();
    expect(mockRevokeMintedKey).not.toHaveBeenCalled();
  });
});

describe('executeVaultApproval — unrecognized kind', () => {
  it('fails cleanly without throwing', async () => {
    const result = await executeVaultApproval(card({ kind: 'vault:unknown-action' }));

    expect(result.ok).toBe(false);
  });
});

describe('executeVaultApproval — never throws', () => {
  it('catches an unexpected error and reports it as a failure', async () => {
    mockMintKeypair.mockRejectedValue(new Error('unexpected'));

    const result = await executeVaultApproval(card({
      kind: 'vault:mint',
      detail: { purpose: 'x', requesterDid: 'did:imajin:x' },
    }));

    expect(result.ok).toBe(false);
  });
});
