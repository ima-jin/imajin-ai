/**
 * deleteSecretAndRevokeGrants (#2698) — the grant revoke, the key-material
 * erase and the tombstone share ONE transaction, with the (non-rollbackable)
 * tombstone file write last so a failure anywhere rolls the database back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTransaction, mockDeleteFromVault, mockErase, calls, state } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockDeleteFromVault: vi.fn(),
  mockErase: vi.fn(),
  calls: [] as string[],
  state: { revokedRows: [] as unknown[], committed: false },
}));

vi.mock('drizzle-orm', () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }));
vi.mock('@/src/db', () => ({
  db: { transaction: mockTransaction },
  vaultDelegationGrants: { id: 'id', field: 'field', keyId: 'key_id', grantedTo: 'granted_to', status: 'status', revokedAt: 'revoked_at' },
}));
vi.mock('../index', () => ({ deleteFromVault: mockDeleteFromVault, eraseInactiveGrantKeyMaterial: mockErase }));

import { deleteSecretAndRevokeGrants } from '../delete-secret';

const FIELD = 'warp-agent-key:did:imajin:abc123';
const TX = { marker: 'tx', update: vi.fn() };
const TOMBSTONE = { field: FIELD, cid: 'cid:tombstone', timestamp: '2026-10-07T00:00:00.000Z' };

/** drizzle's `update().set().where().returning()` chain, recording what status the revoke wrote. */
function revokeChain() {
  let status = '';
  const returning = () => {
    calls.push(`revoke:${status}`);
    return Promise.resolve(state.revokedRows);
  };
  const where = () => ({ returning });
  const set = (values: { status: string }) => {
    status = values.status;
    return { where };
  };
  return { set };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  state.committed = false;
  state.revokedRows = [
    { id: 'vdg_1', field: FIELD, keyId: 'k1', grantedTo: 'did:imajin:node' },
    { id: 'vdg_2', field: FIELD, keyId: 'k2', grantedTo: 'did:imajin:corpus' },
  ];

  TX.update.mockImplementation(() => revokeChain());
  // Mimics drizzle: commit only when the callback resolves; a rejection rolls back and re-throws.
  mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    const result = await callback(TX);
    state.committed = true;
    return result;
  });
  mockErase.mockImplementation(async () => {
    calls.push('erase');
    return [];
  });
  mockDeleteFromVault.mockImplementation(async () => {
    calls.push('tombstone');
    return TOMBSTONE;
  });
});

describe('deleteSecretAndRevokeGrants', () => {
  it('revokes every active grant, erases their key material on the same transaction, then tombstones — in that order', async () => {
    const result = await deleteSecretAndRevokeGrants(FIELD);

    expect(calls).toEqual(['revoke:revoked', 'erase', 'tombstone']);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockErase).toHaveBeenCalledWith(state.revokedRows, TX);
    expect(mockDeleteFromVault).toHaveBeenCalledWith(FIELD);
    expect(result).toEqual({ tombstone: TOMBSTONE, revokedGrantees: ['did:imajin:node', 'did:imajin:corpus'] });
    expect(state.committed).toBe(true);
  });

  it('still tombstones a field that has no active grants', async () => {
    state.revokedRows = [];
    const result = await deleteSecretAndRevokeGrants(FIELD);
    expect(result?.revokedGrantees).toEqual([]);
    expect(mockDeleteFromVault).toHaveBeenCalledTimes(1);
  });

  it('rolls back (rejects the transaction) when the tombstone write fails — grants are not committed as revoked', async () => {
    mockDeleteFromVault.mockRejectedValue(new Error('disk full'));
    await expect(deleteSecretAndRevokeGrants(FIELD)).rejects.toThrow('disk full');
    expect(state.committed).toBe(false);
  });

  it('never tombstones when revoking the grants fails', async () => {
    TX.update.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(deleteSecretAndRevokeGrants(FIELD)).rejects.toThrow('db down');
    expect(mockDeleteFromVault).not.toHaveBeenCalled();
    expect(state.committed).toBe(false);
  });

  it('never tombstones when erasing key material fails', async () => {
    mockErase.mockRejectedValue(new Error('erase failed'));
    await expect(deleteSecretAndRevokeGrants(FIELD)).rejects.toThrow('erase failed');
    expect(mockDeleteFromVault).not.toHaveBeenCalled();
    expect(state.committed).toBe(false);
  });

  it('returns undefined and rolls the revokes back when the field has no entry to tombstone', async () => {
    mockDeleteFromVault.mockResolvedValue(undefined);
    const result = await deleteSecretAndRevokeGrants(FIELD);
    expect(result).toBeUndefined();
    expect(state.committed).toBe(false);
  });
});
