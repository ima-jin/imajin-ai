/**
 * Unit tests for `resolveVaultAuthorization` (#2247, the 2026-09-22
 * signing-roles ruling) — the fail-closed gate every vault:* execution
 * path checks before performing any mutation.
 */
import { describe, it, expect } from 'vitest';
import type { OperatorApprovalCard } from '../../notify/operator-approvals-service';
import { resolveVaultAuthorization } from '../authorization.js';

const VALID_SIGNATURE = { keyId: 'a'.repeat(64), alg: 'ed25519' as const, sig: 'b'.repeat(128) };

function card(overrides: Partial<OperatorApprovalCard> = {}): OperatorApprovalCard {
  return {
    proposalId: 'vprop_1',
    operatorDid: 'did:imajin:operator',
    source: 'vault',
    kind: 'vault:mint',
    summary: 'test',
    keysTouched: [],
    detail: {},
    contentHash: 'c'.repeat(64),
    status: 'approved',
    decision: {
      proposalId: 'vprop_1',
      source: 'vault',
      kind: 'vault:mint',
      decision: 'approve',
      decidedBy: 'did:imajin:operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
      operatorSignature: VALID_SIGNATURE,
    },
    outcome: null,
    appliedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveVaultAuthorization', () => {
  it('returns the authorization reference for a countersigned decision', () => {
    const result = resolveVaultAuthorization(card());

    expect(result).toEqual({
      approvalId: 'vprop_1',
      operatorDid: 'did:imajin:operator',
      contentHash: 'c'.repeat(64),
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns null when there is no decision at all', () => {
    expect(resolveVaultAuthorization(card({ decision: null }))).toBeNull();
  });

  it('returns null when the decision has no operatorSignature', () => {
    const uncountersigned = card();
    uncountersigned.decision = { ...uncountersigned.decision!, operatorSignature: undefined };

    expect(resolveVaultAuthorization(uncountersigned)).toBeNull();
  });

  it('returns null when the decision has no decidedAt', () => {
    const noDecidedAt = card();
    // @ts-expect-error deliberately malformed for the test
    noDecidedAt.decision = { ...noDecidedAt.decision!, decidedAt: undefined };

    expect(resolveVaultAuthorization(noDecidedAt)).toBeNull();
  });

  it('returns null when the card has no contentHash, even with a countersignature present', () => {
    expect(resolveVaultAuthorization(card({ contentHash: null }))).toBeNull();
  });

  it('uses decision.decidedBy for operatorDid, not the card-level operatorDid, in case they ever diverge', () => {
    const mismatched = card({ operatorDid: 'did:imajin:operator-a' });
    mismatched.decision = { ...mismatched.decision!, decidedBy: 'did:imajin:operator-b' };

    const result = resolveVaultAuthorization(mismatched);

    expect(result?.operatorDid).toBe('did:imajin:operator-b');
  });
});
