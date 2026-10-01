/**
 * Unit tests for listOtherActiveGrantees (#2450) — shared by
 * GET /api/vault/grantees/[field] and the server-side guard on
 * rotate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbSelect } = vi.hoisted(() => ({ mockDbSelect: vi.fn() }));

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

  it('exempts internal-secret:* fields without querying — their rotate path re-issues grantees (#2446)', async () => {
    queryReturning([ROW]);
    const guard = await getRotateGranteeGuard('internal-secret:kernel.attestation-internal-api-key', 'did:imajin:node');
    expect(guard).toEqual({ grantees: [], reissuedOnRotate: true });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('stays fail-closed for any other field: returns its grantees, not exempt', async () => {
    queryReturning([ROW]);
    const guard = await getRotateGranteeGuard('GH_TOKEN', 'did:imajin:node');
    expect(guard).toEqual({ grantees: [ROW], reissuedOnRotate: false });
  });

  it('does not exempt a bare "internal-secret:" prefix or a lookalike', async () => {
    queryReturning([ROW]);
    expect((await getRotateGranteeGuard('internal-secret:', 'did:imajin:node')).reissuedOnRotate).toBe(false);
    expect((await getRotateGranteeGuard('x-internal-secret:foo', 'did:imajin:node')).reissuedOnRotate).toBe(false);
  });

  it('propagates a query failure for a non-exempt field', async () => {
    mockDbSelect.mockReturnValue({ from: () => ({ where: () => Promise.reject(new Error('db down')) }) });
    await expect(getRotateGranteeGuard('GH_TOKEN', 'did:imajin:node')).rejects.toThrow('db down');
  });
});
