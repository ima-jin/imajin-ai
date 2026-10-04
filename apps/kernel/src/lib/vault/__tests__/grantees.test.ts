/**
 * Unit tests for listOtherActiveGrantees (#2450) — shared by
 * GET /api/vault/grantees/[field] and the server-side guard on
 * rotate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbSelect, mockIsVaultTier1 } = vi.hoisted(() => ({ mockDbSelect: vi.fn(), mockIsVaultTier1: vi.fn(() => false) }));

vi.mock('../sealing', () => ({ isVaultTier1: mockIsVaultTier1 }));

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect },
  vaultDelegationGrants: {
    id: 'id',
    grantedTo: 'granted_to',
    purpose: 'purpose',
    oneTime: 'one_time',
    expiresAt: 'expires_at',
    field: 'field',
    status: 'status',
    consumedAt: 'consumed_at',
  },
}));

import { listOtherActiveGrantees, getRotateGranteeGuard } from '../grantees';

function queryReturning(rows: unknown[]) {
  mockDbSelect.mockReturnValue({
    from: () => ({ where: () => Promise.resolve(rows) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsVaultTier1.mockReturnValue(false);
});

describe('listOtherActiveGrantees', () => {
  it('returns an empty array when the query finds nothing', async () => {
    queryReturning([]);
    const result = await listOtherActiveGrantees('GH_TOKEN', 'did:imajin:node');
    expect(result).toEqual([]);
  });

  it('maps the raw rows to the VaultGrantee shape, serializing expiresAt', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');
    queryReturning([
      { grantId: 'vdg_1', grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt },
      { grantId: 'vdg_2', grantedTo: 'did:imajin:runner', purpose: null, oneTime: true, expiresAt: null },
    ]);

    const result = await listOtherActiveGrantees('internal-secret:kernel.attestation-internal-api-key', 'did:imajin:node');

    expect(result).toEqual([
      { grantId: 'vdg_1', grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: '2027-01-01T00:00:00.000Z' },
      { grantId: 'vdg_2', grantedTo: 'did:imajin:runner', purpose: null, oneTime: true, expiresAt: null },
    ]);
  });

  it('propagates a query failure', async () => {
    mockDbSelect.mockReturnValue({ from: () => ({ where: () => Promise.reject(new Error('db down')) }) });
    await expect(listOtherActiveGrantees('GH_TOKEN', 'did:imajin:node')).rejects.toThrow('db down');
  });
});

describe('getRotateGranteeGuard (#2450)', () => {
  const ROW = { grantId: 'vdg_1', grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: null };

  it.each([
    ['a connector field', 'quickbooks:did:imajin:user1'],
    ['a Warp sealed key', 'warp-agent-key:did:imajin:user1'],
    ['an internal-secret:* field', 'internal-secret:kernel.attestation-internal-api-key'],
  ])('Tier 0: lists the grantees of %s and reports that rotate re-issues them', async (_label, field) => {
    queryReturning([ROW]);
    const guard = await getRotateGranteeGuard(field, 'did:imajin:node');
    expect(guard).toEqual({ grantees: [ROW], reissuedOnRotate: true });
  });

  it('Tier 0: a field with no other grantees reports an empty list', async () => {
    queryReturning([]);
    expect(await getRotateGranteeGuard('GH_TOKEN', 'did:imajin:node')).toEqual({ grantees: [], reissuedOnRotate: true });
  });

  it('Tier 1: stays fail-closed — grantees are listed and rotate does not re-issue them', async () => {
    mockIsVaultTier1.mockReturnValue(true);
    queryReturning([ROW]);
    expect(await getRotateGranteeGuard('GH_TOKEN', 'did:imajin:node')).toEqual({ grantees: [ROW], reissuedOnRotate: false });
  });

  it('propagates a query failure', async () => {
    mockDbSelect.mockReturnValue({ from: () => ({ where: () => Promise.reject(new Error('db down')) }) });
    await expect(getRotateGranteeGuard('GH_TOKEN', 'did:imajin:node')).rejects.toThrow('db down');
  });
});
