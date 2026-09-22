/**
 * Unit tests for `executeVaultApproval` (#2247) — the bridge that turns an
 * approved `source: 'vault'` operator-approval card into the actual vault
 * mutation (mint/grant/rotate/revoke), and the stub for 'vault:claim'.
 *
 * Covers the 2026-09-22 signing-roles ruling (epic #2084, #2078/#2158/
 * #2082): every mutation executes under the NODE identity (never the
 * operator's), carries the countersigned decision's `authorizedBy`
 * reference on its mechanical attestation/event, and fails CLOSED when
 * the decision was never countersigned by the operator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OperatorApprovalCard } from '../../notify/operator-approvals-service';

const {
  mockMintKeypair,
  mockEmitMintedEvents,
  mockRevokeMintedKey,
  mockEmitRevokedEvents,
  mockEmitWithdrawnEvents,
  mockGrantExistingMintedKey,
  mockEmitGrantEvents,
  mockGetMintedKeyByDid,
  mockRevokeStaticSecretGrant,
  mockGetNodeSigningIdentity,
} = vi.hoisted(() => ({
  mockMintKeypair: vi.fn(),
  mockEmitMintedEvents: vi.fn(),
  mockRevokeMintedKey: vi.fn(),
  mockEmitRevokedEvents: vi.fn(),
  mockEmitWithdrawnEvents: vi.fn(),
  mockGrantExistingMintedKey: vi.fn(),
  mockEmitGrantEvents: vi.fn(),
  mockGetMintedKeyByDid: vi.fn(),
  mockRevokeStaticSecretGrant: vi.fn(),
  mockGetNodeSigningIdentity: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../mint', () => ({
  mintKeypair: mockMintKeypair,
  emitMintedEvents: mockEmitMintedEvents,
  revokeMintedKey: mockRevokeMintedKey,
  emitRevokedEvents: mockEmitRevokedEvents,
  emitWithdrawnEvents: mockEmitWithdrawnEvents,
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

vi.mock('../sealing', () => ({
  getNodeSigningIdentity: mockGetNodeSigningIdentity,
}));

import { executeVaultApproval } from '../approvals-execution.js';

const NODE_DID = 'did:imajin:node';
const OPERATOR_DID = 'did:imajin:operator';

const VALID_COUNTERSIGNATURE = { keyId: 'a'.repeat(64), alg: 'ed25519' as const, sig: 'b'.repeat(128) };

function card(overrides: Partial<OperatorApprovalCard> = {}): OperatorApprovalCard {
  return {
    proposalId: 'vprop_1',
    operatorDid: OPERATOR_DID,
    source: 'vault',
    kind: 'vault:mint',
    summary: 'test',
    keysTouched: [],
    detail: {},
    contentHash: 'a'.repeat(64),
    status: 'approved',
    decision: {
      proposalId: 'vprop_1',
      source: 'vault',
      kind: 'vault:mint',
      decision: 'approve',
      decidedBy: OPERATOR_DID,
      decidedAt: '2026-01-01T00:00:00.000Z',
      operatorSignature: VALID_COUNTERSIGNATURE,
    },
    outcome: null,
    appliedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const EXPECTED_AUTHORIZED_BY = {
  approvalId: 'vprop_1',
  operatorDid: OPERATOR_DID,
  contentHash: 'a'.repeat(64),
  decidedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNodeSigningIdentity.mockReturnValue({ senderDid: NODE_DID, senderPubkey: 'node-pub', privateKeyHex: 'node-priv' });
});

describe('executeVaultApproval — fail-closed countersignature gate (signing-roles ruling)', () => {
  it('refuses execution when the decision carries no operatorSignature at all', async () => {
    const result = await executeVaultApproval(card({
      decision: { proposalId: 'vprop_1', source: 'vault', kind: 'vault:mint', decision: 'approve', decidedBy: OPERATOR_DID, decidedAt: '2026-01-01T00:00:00.000Z' },
      detail: { purpose: 'x', requesterDid: 'did:imajin:x' },
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/countersigned/);
    expect(mockMintKeypair).not.toHaveBeenCalled();
  });

  it('refuses execution when there is no decision at all', async () => {
    const result = await executeVaultApproval(card({ decision: null, detail: { purpose: 'x', requesterDid: 'did:imajin:x' } }));

    expect(result.ok).toBe(false);
    expect(mockMintKeypair).not.toHaveBeenCalled();
  });

  it('refuses execution when contentHash is missing even with a countersignature present', async () => {
    const result = await executeVaultApproval(card({ contentHash: null, detail: { purpose: 'x', requesterDid: 'did:imajin:x' } }));

    expect(result.ok).toBe(false);
    expect(mockMintKeypair).not.toHaveBeenCalled();
  });

  it('applies the same gate to vault:grant, vault:rotate, and vault:revoke', async () => {
    const uncountersigned = { decision: { proposalId: 'vprop_1', source: 'vault', kind: 'vault:x', decision: 'approve' as const, decidedBy: OPERATOR_DID, decidedAt: '2026-01-01T00:00:00.000Z' } };

    await executeVaultApproval(card({ kind: 'vault:grant', detail: { did: 'did:imajin:x', grantedTo: 'did:imajin:y' }, ...uncountersigned }));
    await executeVaultApproval(card({ kind: 'vault:rotate', detail: { did: 'did:imajin:x' }, ...uncountersigned }));
    await executeVaultApproval(card({ kind: 'vault:revoke', detail: { did: 'did:imajin:x' }, ...uncountersigned }));

    expect(mockGrantExistingMintedKey).not.toHaveBeenCalled();
    expect(mockGetMintedKeyByDid).not.toHaveBeenCalled();
  });
});

describe('executeVaultApproval — vault:mint', () => {
  it('mints under the NODE identity (never the operator) and carries the authorizedBy reference', async () => {
    mockMintKeypair.mockResolvedValue({ mintId: 'vmk_1', did: 'did:imajin:new', publicKey: 'pk', field: 'f', grantId: 'vdg_1', requestId: null });

    const result = await executeVaultApproval(card({
      kind: 'vault:mint',
      detail: { purpose: 'corpus-identity', requesterDid: 'did:imajin:corpus-bootstrap' },
    }));

    expect(result.ok).toBe(true);
    expect(mockMintKeypair).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'corpus-identity',
      requesterDid: 'did:imajin:corpus-bootstrap',
      mintedBy: NODE_DID,
    }));
    expect(mockEmitMintedEvents).toHaveBeenCalledWith(expect.objectContaining({
      mintedBy: NODE_DID,
      authorizedBy: EXPECTED_AUTHORIZED_BY,
    }));
  });

  it('fails without calling mintKeypair when purpose/requesterDid are missing', async () => {
    const result = await executeVaultApproval(card({ kind: 'vault:mint', detail: {} }));

    expect(result.ok).toBe(false);
    expect(mockMintKeypair).not.toHaveBeenCalled();
  });
});

describe('executeVaultApproval — vault:grant', () => {
  it('grants under the NODE identity and carries authorizedBy on the emitted event', async () => {
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
      grantedBy: NODE_DID,
    }));
    expect(mockEmitGrantEvents).toHaveBeenCalledWith(expect.objectContaining({
      grantedBy: NODE_DID,
      authorizedBy: EXPECTED_AUTHORIZED_BY,
    }));
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

describe('executeVaultApproval — vault:rotate (happy path)', () => {
  it("mints a replacement for the OLD key's consumer under the NODE identity, then revokes the old key", async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ purpose: 'corpus-identity', requestedBy: 'did:imajin:corpus-bootstrap' });
    mockMintKeypair.mockResolvedValue({ mintId: 'vmk_2', did: 'did:imajin:new', publicKey: 'pk', field: 'f', grantId: 'vdg_2', requestId: null });
    mockRevokeMintedKey.mockResolvedValue({ status: 'revoked', record: { id: 'vmk_1', did: 'did:imajin:old', publicKey: 'pk-old' } });

    const result = await executeVaultApproval(card({ kind: 'vault:rotate', detail: { did: 'did:imajin:old' } }));

    expect(result.ok).toBe(true);
    expect(mockMintKeypair).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'corpus-identity',
      requesterDid: 'did:imajin:corpus-bootstrap',
      mintedBy: NODE_DID,
    }));
    expect(mockRevokeMintedKey).toHaveBeenCalledWith({ did: 'did:imajin:old', revokedBy: NODE_DID });
    expect(mockEmitRevokedEvents).toHaveBeenCalledWith(expect.anything(), NODE_DID, EXPECTED_AUTHORIZED_BY);
  });

  it('fails when the old did is not a known minted key', async () => {
    mockGetMintedKeyByDid.mockResolvedValue(undefined);

    const result = await executeVaultApproval(card({ kind: 'vault:rotate', detail: { did: 'did:imajin:unknown' } }));

    expect(result.ok).toBe(false);
    expect(mockMintKeypair).not.toHaveBeenCalled();
  });

  it('treats already_revoked on the old key as success (the goal already held)', async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ purpose: 'p', requestedBy: 'did:imajin:x' });
    mockMintKeypair.mockResolvedValue({ mintId: 'vmk_2', did: 'did:imajin:new', publicKey: 'pk', field: 'f', grantId: 'vdg_2', requestId: null });
    mockRevokeMintedKey.mockResolvedValue({ status: 'already_revoked', record: { id: 'vmk_1', did: 'did:imajin:old' } });

    const result = await executeVaultApproval(card({ kind: 'vault:rotate', detail: { did: 'did:imajin:old' } }));

    expect(result.ok).toBe(true);
    // No new revoke event for a no-op — nothing changed on the old key.
    expect(mockEmitRevokedEvents).not.toHaveBeenCalled();
  });
});

describe('executeVaultApproval — vault:rotate (saga partial-failure cleanup)', () => {
  it('rolls back (tombstones) the just-minted new key when revoking the old key THROWS, and reports the failed step', async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ purpose: 'p', requestedBy: 'did:imajin:corpus-bootstrap' });
    const minted = { mintId: 'vmk_2', did: 'did:imajin:new', publicKey: 'pk', field: 'f', grantId: 'vdg_2', requestId: null };
    mockMintKeypair.mockResolvedValue(minted);
    mockRevokeMintedKey
      .mockRejectedValueOnce(new Error('db unavailable')) // the OLD-key revoke attempt
      .mockResolvedValueOnce({ status: 'revoked', record: { id: 'vmk_2', did: 'did:imajin:new', publicKey: 'pk' } }); // the rollback of the NEW key

    const result = await executeVaultApproval(card({ kind: 'vault:rotate', detail: { did: 'did:imajin:old' } }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/revoke/);
    expect(result.error).toMatch(/rolled back/);
    // Cleanup revoked the NEW key (no dangling live key).
    expect(mockRevokeMintedKey).toHaveBeenNthCalledWith(1, { did: 'did:imajin:old', revokedBy: NODE_DID });
    expect(mockRevokeMintedKey).toHaveBeenNthCalledWith(2, { did: minted.did, revokedBy: NODE_DID });
    // The mint WAS real (audited), and so is the rollback tombstone.
    expect(mockEmitMintedEvents).toHaveBeenCalledTimes(1);
    expect(mockEmitRevokedEvents).toHaveBeenCalledTimes(1);
    expect(mockEmitRevokedEvents).toHaveBeenCalledWith(expect.objectContaining({ did: minted.did }), NODE_DID, EXPECTED_AUTHORIZED_BY);
  });

  it('rolls back the new key when the old key is not_found at revoke time (race/caller error)', async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ purpose: 'p', requestedBy: 'did:imajin:corpus-bootstrap' });
    const minted = { mintId: 'vmk_2', did: 'did:imajin:new', publicKey: 'pk', field: 'f', grantId: 'vdg_2', requestId: null };
    mockMintKeypair.mockResolvedValue(minted);
    mockRevokeMintedKey
      .mockResolvedValueOnce({ status: 'not_found' }) // old key vanished
      .mockResolvedValueOnce({ status: 'revoked', record: { id: 'vmk_2', did: 'did:imajin:new', publicKey: 'pk' } }); // rollback of new key

    const result = await executeVaultApproval(card({ kind: 'vault:rotate', detail: { did: 'did:imajin:old' } }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rolled back/);
    expect(mockRevokeMintedKey).toHaveBeenNthCalledWith(2, { did: minted.did, revokedBy: NODE_DID });
    expect(mockEmitRevokedEvents).toHaveBeenCalledWith(expect.objectContaining({ did: minted.did }), NODE_DID, EXPECTED_AUTHORIZED_BY);
  });

  it('reports failure with no cleanup when mintKeypair itself throws (nothing new was created)', async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ purpose: 'p', requestedBy: 'did:imajin:x' });
    mockMintKeypair.mockRejectedValue(new Error('seal failed'));

    const result = await executeVaultApproval(card({ kind: 'vault:rotate', detail: { did: 'did:imajin:old' } }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mint/);
    expect(mockRevokeMintedKey).not.toHaveBeenCalled();
    expect(mockEmitMintedEvents).not.toHaveBeenCalled();
  });

  it('never throws even when the rollback cleanup itself fails', async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ purpose: 'p', requestedBy: 'did:imajin:x' });
    const minted = { mintId: 'vmk_2', did: 'did:imajin:new', publicKey: 'pk', field: 'f', grantId: 'vdg_2', requestId: null };
    mockMintKeypair.mockResolvedValue(minted);
    mockRevokeMintedKey
      .mockRejectedValueOnce(new Error('db unavailable')) // old-key revoke fails
      .mockRejectedValueOnce(new Error('rollback also fails')); // cleanup of new key also fails

    const result = await executeVaultApproval(card({ kind: 'vault:rotate', detail: { did: 'did:imajin:old' } }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/revoke/);
  });
});

describe('executeVaultApproval — vault:revoke', () => {
  it("tier withdraw calls revokeStaticSecretGrant and emits vault.key.withdrawn under the NODE identity when a grant WAS deactivated", async () => {
    const record = { field: 'vault-minted-key:did:imajin:x', requestedBy: 'did:imajin:corpus-bootstrap' };
    mockGetMintedKeyByDid.mockResolvedValue(record);
    mockRevokeStaticSecretGrant.mockResolvedValue(true);

    const result = await executeVaultApproval(card({ kind: 'vault:revoke', detail: { did: 'did:imajin:x', tier: 'withdraw' } }));

    expect(result.ok).toBe(true);
    expect(mockRevokeStaticSecretGrant).toHaveBeenCalledWith('vault-minted-key:did:imajin:x', 'did:imajin:corpus-bootstrap');
    expect(mockRevokeMintedKey).not.toHaveBeenCalled();
    expect(mockEmitWithdrawnEvents).toHaveBeenCalledWith(record, NODE_DID, EXPECTED_AUTHORIZED_BY);
  });

  it('tier withdraw does NOT emit an event when nothing was actually deactivated (no active grant to withdraw)', async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ field: 'vault-minted-key:did:imajin:x', requestedBy: 'did:imajin:corpus-bootstrap' });
    mockRevokeStaticSecretGrant.mockResolvedValue(false);

    const result = await executeVaultApproval(card({ kind: 'vault:revoke', detail: { did: 'did:imajin:x', tier: 'withdraw' } }));

    expect(result.ok).toBe(true);
    expect(mockEmitWithdrawnEvents).not.toHaveBeenCalled();
  });

  it.each(['tombstone', 'destroy'])('tier %s calls the full revokeMintedKey tombstone under the NODE identity', async (tier) => {
    mockGetMintedKeyByDid.mockResolvedValue({ field: 'vault-minted-key:did:imajin:x', requestedBy: 'did:imajin:corpus-bootstrap' });
    mockRevokeMintedKey.mockResolvedValue({ status: 'revoked', record: { id: 'vmk_1', did: 'did:imajin:x', publicKey: 'pk' } });

    const result = await executeVaultApproval(card({ kind: 'vault:revoke', detail: { did: 'did:imajin:x', tier } }));

    expect(result.ok).toBe(true);
    expect(mockRevokeMintedKey).toHaveBeenCalledWith({ did: 'did:imajin:x', revokedBy: NODE_DID });
    expect(mockEmitRevokedEvents).toHaveBeenCalledWith(expect.anything(), NODE_DID, EXPECTED_AUTHORIZED_BY);
  });

  it('fails when the did is unknown', async () => {
    mockGetMintedKeyByDid.mockResolvedValue(undefined);

    const result = await executeVaultApproval(card({ kind: 'vault:revoke', detail: { did: 'did:imajin:unknown' } }));

    expect(result.ok).toBe(false);
  });

  it('defaults to withdraw when no tier is supplied', async () => {
    mockGetMintedKeyByDid.mockResolvedValue({ field: 'vault-minted-key:did:imajin:x', requestedBy: 'did:imajin:corpus-bootstrap' });
    mockRevokeStaticSecretGrant.mockResolvedValue(true);

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
