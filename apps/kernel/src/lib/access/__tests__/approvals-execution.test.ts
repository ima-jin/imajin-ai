/**
 * Unit tests for `executeAccessApproval` (#2252) — the bridge that turns an
 * approved `source: 'access'` operator-approval card into the actual
 * delegate-grant bearer mint. Mirrors
 * `vault/__tests__/approvals-execution.test.ts`'s coverage of the shared
 * #2084 signing-roles gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OperatorApprovalCard } from '../../notify/operator-approvals-service';

const {
  mockGetDelegateGrantRequestById,
  mockMarkDelegateGrantRequestExpired,
  mockIssueDelegateGrantBearer,
  mockGetNodeSigningIdentity,
} = vi.hoisted(() => ({
  mockGetDelegateGrantRequestById: vi.fn(),
  mockMarkDelegateGrantRequestExpired: vi.fn(),
  mockIssueDelegateGrantBearer: vi.fn(),
  mockGetNodeSigningIdentity: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../delegate-grant', () => ({
  getDelegateGrantRequestById: mockGetDelegateGrantRequestById,
  markDelegateGrantRequestExpired: mockMarkDelegateGrantRequestExpired,
  issueDelegateGrantBearer: mockIssueDelegateGrantBearer,
}));

vi.mock('../../vault/sealing', () => ({
  getNodeSigningIdentity: mockGetNodeSigningIdentity,
}));

import { executeAccessApproval, ACCESS_BEARER_GRANT_KIND } from '../approvals-execution.js';

const NODE_DID = 'did:imajin:node';
const OPERATOR_DID = 'did:imajin:operator';

const VALID_COUNTERSIGNATURE = { keyId: 'a'.repeat(64), alg: 'ed25519' as const, sig: 'b'.repeat(128) };

function card(overrides: Partial<OperatorApprovalCard> = {}): OperatorApprovalCard {
  return {
    proposalId: 'aprop_1',
    operatorDid: OPERATOR_DID,
    source: 'access',
    kind: ACCESS_BEARER_GRANT_KIND,
    summary: 'test',
    keysTouched: [],
    detail: { requestId: 'dgr_1' },
    contentHash: 'a'.repeat(64),
    status: 'approved',
    decision: {
      proposalId: 'aprop_1',
      source: 'access',
      kind: ACCESS_BEARER_GRANT_KIND,
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
  approvalId: 'aprop_1',
  operatorDid: OPERATOR_DID,
  contentHash: 'a'.repeat(64),
  decidedAt: '2026-01-01T00:00:00.000Z',
};

function pendingRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'dgr_1',
    principalDid: 'did:imajin:ryan',
    clientLabel: 'Muse Code',
    purpose: 'read my media',
    scopes: ['discovery:read'],
    surfaces: ['mcp'],
    slidingWindowDays: 90,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNodeSigningIdentity.mockReturnValue({ senderDid: NODE_DID, senderPubkey: 'node-pub', privateKeyHex: 'node-priv' });
});

describe('executeAccessApproval — fail-closed countersignature gate (#2084)', () => {
  it('refuses execution when the decision carries no operatorSignature at all', async () => {
    const result = await executeAccessApproval(card({
      decision: { proposalId: 'aprop_1', source: 'access', kind: ACCESS_BEARER_GRANT_KIND, decision: 'approve', decidedBy: OPERATOR_DID, decidedAt: '2026-01-01T00:00:00.000Z' },
    }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/countersigned/);
    expect(mockGetDelegateGrantRequestById).not.toHaveBeenCalled();
    expect(mockIssueDelegateGrantBearer).not.toHaveBeenCalled();
  });

  it('refuses execution when there is no decision at all', async () => {
    const result = await executeAccessApproval(card({ decision: null }));
    expect(result.ok).toBe(false);
    expect(mockIssueDelegateGrantBearer).not.toHaveBeenCalled();
  });

  it('refuses execution when contentHash is missing even with a countersignature present', async () => {
    const result = await executeAccessApproval(card({ contentHash: null }));
    expect(result.ok).toBe(false);
    expect(mockIssueDelegateGrantBearer).not.toHaveBeenCalled();
  });
});

describe('executeAccessApproval — kind/detail validation', () => {
  it('rejects an unrecognized kind', async () => {
    const result = await executeAccessApproval(card({ kind: 'access:something-else' }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Unrecognized access proposal kind/);
  });

  it('rejects a proposal missing detail.requestId', async () => {
    const result = await executeAccessApproval(card({ detail: {} }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/requestId/);
    expect(mockGetDelegateGrantRequestById).not.toHaveBeenCalled();
  });
});

describe('executeAccessApproval — request lifecycle', () => {
  it('fails when no delegate-grant request exists for the given id', async () => {
    mockGetDelegateGrantRequestById.mockResolvedValue(undefined);
    const result = await executeAccessApproval(card());
    expect(result.ok).toBe(false);
    expect(mockIssueDelegateGrantBearer).not.toHaveBeenCalled();
  });

  it('fails when the request is no longer pending', async () => {
    mockGetDelegateGrantRequestById.mockResolvedValue(pendingRequest({ status: 'approved' }));
    const result = await executeAccessApproval(card());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/not pending/);
    expect(mockIssueDelegateGrantBearer).not.toHaveBeenCalled();
  });

  it('marks an expired knock expired and refuses to mint', async () => {
    mockGetDelegateGrantRequestById.mockResolvedValue(pendingRequest({ expiresAt: new Date(Date.now() - 1000) }));
    const result = await executeAccessApproval(card());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/expired/);
    expect(mockMarkDelegateGrantRequestExpired).toHaveBeenCalledWith('dgr_1');
    expect(mockIssueDelegateGrantBearer).not.toHaveBeenCalled();
  });
});

describe('executeAccessApproval — success path', () => {
  it('mints under the NODE identity (never the operator) and returns the bearer data', async () => {
    const request = pendingRequest();
    mockGetDelegateGrantRequestById.mockResolvedValue(request);
    mockIssueDelegateGrantBearer.mockResolvedValue({
      bearer: 'plaintext-bearer',
      bearerId: 'dgb_1',
      expiresAt: '2026-04-01T00:00:00.000Z',
      hardCapAt: '2026-04-15T00:00:00.000Z',
    });

    const result = await executeAccessApproval(card());

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual({
      bearer: 'plaintext-bearer',
      bearerId: 'dgb_1',
      expiresAt: '2026-04-01T00:00:00.000Z',
      hardCapAt: '2026-04-15T00:00:00.000Z',
    });
    expect(mockIssueDelegateGrantBearer).toHaveBeenCalledWith({
      request,
      issuedBy: NODE_DID,
      authorizedBy: EXPECTED_AUTHORIZED_BY,
    });
  });

  it('reports a mint failure without throwing', async () => {
    mockGetDelegateGrantRequestById.mockResolvedValue(pendingRequest());
    mockIssueDelegateGrantBearer.mockRejectedValue(new Error('db exploded'));

    const result = await executeAccessApproval(card());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/execution failed/i);
  });
});
